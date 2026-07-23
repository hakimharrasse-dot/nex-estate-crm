// ============================================================
// /api/lastminute-run.js — Nex-Estate CRM
// Automatisation LAST-MINUTE : quand une réservation arrive APRÈS
// l'heure de déclenchement des messages automatiques Smoobu
// (B "Prepare your arrival" à J-2 12h-13h, "Departure information"
// à J-1 21h-22h — tous deux avec "envoi si passé" DÉCOCHÉ),
// le CRM détecte le trou et envoie lui-même le bon message.
//
// Endpoints :
//   POST / GET (no query) → run complet : scan candidats + envois dus
//   POST ?booking=SID     → run ciblé sur une réservation (appelé par le webhook)
//   GET  ?status=1        → état de la table scheduled_messages (lecture seule)
//   GET  ?dryrun=1        → scan + décisions SANS envoyer (diagnostic)
//
// Déclenchement :
//   1. Temps réel : smoobu-webhook.js forwarde newReservation/updateReservation/
//      cancelReservation ici (?booking=SID).
//   2. Filet : pg_cron Supabase appelle ce endpoint toutes les 10 min
//      (job 'nex-lastminute-runner') — rattrape webhooks perdus + envois différés.
//
// RÈGLES MÉTIER (validées Hakim 2026-07-21) :
//   - Le CODE D'ACCÈS ne part JAMAIS automatiquement (absent des templates).
//   - Zéro double envoi : on n'envoie que si Smoobu n'a pas pu (fenêtre passée),
//     ET après vérification qu'aucun message équivalent n'existe déjà dans la
//     conversation (Smoobu, envoi manuel de Hakim…).
//   - Annulation / modification de dates : re-vérifiées au moment de l'envoi.
//   - Textes par logement : logements.kb.msg_lastminute / msg_depart (fallback code).
//
// FENÊTRES SMOOBU (constatées dans Smoobu le 2026-07-21, heure locale Maroc) :
//   B      : 2 jours avant Arrivée, 12h00-13h00
//   Départ : 1 jour avant Départ,   21h00-22h00
// En UTC on encadre large (le fuseau exact du compte Smoobu n'est pas exposé ;
// Maroc = UTC+1, Berlin été = UTC+2) :
//   B  : fenêtre possible [10:00, 12:00] UTC → fin sûre B1 = 12:45 UTC (J-2)
//   Dép: fenêtre possible [19:00, 21:00] UTC → fin sûre D1 = 21:30 UTC (J-1)
// Une résa créée AVANT le début de fenêtre → Smoobu s'en charge → skip.
// Créée PENDANT la zone ambiguë → envoi différé après la fin sûre + contrôle
// anti-doublon dans la conversation. Créée APRÈS → envoi immédiat (+ contrôle).
//
// Sécurité endpoint : AUCUN paramètre d'entrée ne modifie le contenu envoyé —
// le run est idempotent et ne fait que traiter l'état DB/Smoobu. Un appel
// non autorisé ne peut rien envoyer que le cron n'aurait pas envoyé 10 min
// plus tard (verrou unique smoobu_id+kind + claim atomique anti-concurrence).
// ============================================================

'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMOOBU_HOST  = 'https://login.smoobu.com';
const SMOOBU_SECRET = process.env.SMOOBU_API_SECRET || '';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

const APPARTS_VALIDES = ['Agdal 13', 'Touahri 11', 'Riad Ahl Sala', 'Résidence Al Boustane'];

// Fenêtres Smoobu en UTC (voir en-tête). J-2 / J-1 par rapport à checkin/checkout.
const B_WIN_START_UTC = { h: 10, m: 0 };  // début fenêtre B le plus tôt possible
const B_SAFE_END_UTC  = { h: 12, m: 45 }; // fin sûre fenêtre B
const D_WIN_START_UTC = { h: 19, m: 0 };  // début fenêtre Départ le plus tôt possible
const D_SAFE_END_UTC  = { h: 21, m: 30 }; // fin sûre fenêtre Départ
const BLM_DELAY_MS    = 7 * 60 * 1000;    // B-LM ≈ 7 min après la réception (laisse le Welcome partir)
const DEPART_DELAY_MS = 60 * 60 * 1000;   // départ ≈ 1h après le B-LM (règle Hakim)

// Lancement propre : les résas créées AVANT le déploiement de l'automatisation
// ont été gérées manuellement par Hakim (souvent hors conversation Smoobu,
// ex. WhatsApp) → on ne les traite JAMAIS. Seules les résas créées après cette
// date/heure entrent dans l'automatisation.
const LAUNCH_EPOCH = new Date(Date.UTC(2026, 6, 21, 17, 0, 0)); // 2026-07-21 17:00 UTC

// ── Templates de secours (si logements.kb.msg_* absent) ───────
// ⚠️ JAMAIS de code d'accès ici — le code reste 100 % manuel après
// vérification du check-in en ligne (règle absolue).
const FALLBACK_BLM =
  'Bonjour {prenom},\n\n' +
  'Pour préparer votre arrivée, une seule étape :\n' +
  '👉 Complétez votre check-in en ligne : {checkin_url}\n' +
  '(Pièce d\'identité + acceptation des conditions de séjour)\n\n' +
  '🔑 Votre code d\'accès vous sera envoyé dès que le check-in est complété.\n\n' +
  '📖 Votre guide de séjour (accès, Wi-Fi, services) : {guide}\n\n' +
  '⏰ Arrivée entre 15h et 20h. Autre créneau ? Contactez-moi.\n\n' +
  'Hakim — Nex-Estate';

const FALLBACK_DEPART =
  'Bonjour {prenom},\n\n' +
  'Nous espérons que vous appréciez votre séjour !\n' +
  'Départ prévu le {date_depart} avant 11h.\n\n' +
  '🧺 Merci de vérifier que toutes les serviettes fournies sont bien laissées dans l\'appartement.\n' +
  '❄️ Merci d\'éteindre la climatisation et les lumières.\n\n' +
  'Merci encore et à très bientôt !\n' +
  'Hakim — Nex-Estate';

// ── uid maison (même style que le reste du CRM) ───────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ── Smoobu HMAC-SHA256 — bloc IDENTIQUE à smoobu-messages.js ──
function _smoobuQuery(query) {
  if (!query) return '';
  const keys = Object.keys(query).filter((k) => query[k] !== undefined && query[k] !== null);
  if (!keys.length) return '';
  keys.sort();
  return keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
}

async function smoobuFetch(path, { method = 'GET', query = null, body = null } = {}) {
  const key = process.env.SMOOBU_API_KEY;
  const qs  = _smoobuQuery(query);
  const url = SMOOBU_HOST + path + (qs ? `?${qs}` : '');
  const bodyString = body != null ? JSON.stringify(body) : '';
  let headers;
  if (!SMOOBU_SECRET) {
    headers = { 'Content-Type': 'application/json', 'Api-Key': key };
  } else {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const nonce     = crypto.randomUUID();
    const bodyHash  = bodyString ? crypto.createHash('sha256').update(bodyString, 'utf8').digest('hex') : EMPTY_SHA256;
    const canonical = [method.toUpperCase(), path, qs, timestamp, nonce, bodyHash, key].join('\n');
    const signature = crypto.createHmac('sha256', SMOOBU_SECRET).update(canonical, 'utf8').digest('base64');
    headers = {
      'Content-Type': 'application/json',
      'Api-Key': key, 'X-API-Key': key,
      'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature,
    };
  }
  const init = { method, headers };
  if (body != null) init.body = bodyString;
  return fetch(url, init);
}

// ── Supabase REST (service_role) ──────────────────────────────
async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase [${path.slice(0, 60)}]: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const sbGet = (p) => sbFetch(p, { method: 'GET' });
const sbInsert = (t, row, prefer) => sbFetch(t, {
  method: 'POST',
  headers: { 'Prefer': prefer || 'return=minimal' },
  body: JSON.stringify(row),
});
const sbPatch = (t, filter, patch, prefer) => sbFetch(`${t}?${filter}`, {
  method: 'PATCH',
  headers: { 'Prefer': prefer || 'return=minimal' },
  body: JSON.stringify(patch),
});

// ── Smoobu : détail réservation (created-at, guest-app-url…) ──
async function getBooking(sid) {
  const res = await smoobuFetch(`/api/reservations/${sid}`);
  if (!res.ok) return null;
  return res.json();
}

// ── Smoobu : URL du FORMULAIRE de check-in en ligne ───────────
// ⚠️ Correctif 2026-07-23 (cas réel ابوباسل 148589056) : guest-app-url ≠ lien
// check-in. L'API guest (/api-guest/bookings/{id}?token={t}) expose
// onlineCheckInUrl (login.smoobu.com/<lang>/online-check-in/check-in/<hash>),
// localisé dans la langue du voyageur. Le token = param t de guest-app-url.
// Endpoint public invité (pas de clé API ni HMAC). Fallback : null → {guide}.
async function getOnlineCheckInUrl(sid, guestAppUrl) {
  try {
    const m = String(guestAppUrl || '').match(/[?&]t=([A-Za-z0-9]+)/);
    if (!m) return null;
    const res = await fetch(`${SMOOBU_HOST}/api-guest/bookings/${sid}?token=${m[1]}`);
    if (!res.ok) return null;
    const data = await res.json();
    const url = String(data?.onlineCheckInUrl || '').trim();
    return /^https:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

// ── Smoobu : messages d'une résa (paginé, host inclus) ────────
async function getConvMessages(sid) {
  const MAX_PAGES = 20;
  const pageMsgs = (d) => d?.messages || d?.data || (Array.isArray(d) ? d : []);
  const fetchPage = async (page) => {
    const res = await smoobuFetch(`/api/reservations/${sid}/messages`, {
      query: { onlyRelatedToGuest: 'false', page },
    });
    if (res.status === 404) return { _nf: true };
    if (!res.ok) throw new Error(`Smoobu messages ${sid} p${page}: ${res.status}`);
    return res.json();
  };
  const first = await fetchPage(1);
  if (first._nf) return [];
  const pageCount = Math.min(Number(first?.page_count) || 1, MAX_PAGES);
  let all = pageMsgs(first);
  if (pageCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, k) => fetchPage(k + 2))
    );
    for (const d of rest) all = all.concat(pageMsgs(d));
  }
  return all;
}

function isHostMessage(m) {
  if (typeof m.type === 'number') return m.type === 2;
  const s = String(m.type || m.sender || m.from || '').toLowerCase();
  return s === 'host' || s === 'owner' || s === 'sent';
}

function msgText(m) {
  const raw = m.message || m.text_content || m.text || m.body || m.content || m.subject || '';
  return String(raw).replace(/<[^>]+>/g, ' ');
}

// /reservations/{id}/messages renvoie created_at en UTC (fait structurel vérifié
// 2026-07-03 — contrairement à /threads qui est en heure de Berlin).
function msgDateUtc(m) {
  const raw = m.created_at || m.createdAt || m.sentAt || m.sent_at || m.date || '';
  const mm = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!mm) return null;
  return new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +(mm[6] || 0)));
}

// ── Envoi Smoobu ──────────────────────────────────────────────
async function sendSmoobuMessage(sid, text) {
  const res = await smoobuFetch(`/api/reservations/${sid}/messages/send-message-to-guest`, {
    method: 'POST',
    body:   { messageBody: text },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Smoobu send ${sid}: ${res.status} ${raw.slice(0, 200)}`);
  return true;
}

// ── Dates utilitaires ─────────────────────────────────────────
// 'YYYY-MM-DD' + décalage jours + heure/minute UTC → Date UTC
function dayAtUtc(ymd, dayOffset, hm) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + dayOffset, hm.h, hm.m, 0));
}

// Offset (minutes) de Europe/Berlin à un instant UTC donné : +120 en été (CEST),
// +60 en hiver (CET). DST-safe via Intl. (Berlin = Paris comme offset.)
function berlinOffsetMin(utcMs) {
  const s = new Date(utcMs).toLocaleString('en-US', {
    timeZone: 'Europe/Berlin', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/);
  if (!m) return 60;
  const asUTC = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return Math.round((asUTC - utcMs) / 60000);
}

// created-at Smoobu 'YYYY-MM-DD HH:MM' — ⚠️ FAIT STRUCTUREL (vérifié 2026-07-23) :
// l'heure est en EUROPE/BERLIN, PAS au Maroc (ex. résa réelle à 17:47 UTC affichée
// "19:47" = Berlin CEST UTC+2). L'ancien code soustrayait 1h fixe (Maroc UTC+1) →
// createdUtc calculé 1h trop tard → B-LM envoyé ~1h après la résa (cas Amal/Jihane).
// On convertit désormais Berlin→UTC avec l'offset réel de la date (DST-safe).
function createdAtUtc(booking) {
  const raw = String(booking?.['created-at'] || '');
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const guessUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  return new Date(guessUTC - berlinOffsetMin(guessUTC) * 60000);
}

function frDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd || '';
}

function firstName(voyageur) {
  const w = String(voyageur || '').trim().split(/\s+/)[0] || '';
  return w || 'et bienvenue';
}

// ── Décision par réservation et par type de message ───────────
// Retourne { action: 'skip'|'schedule', dueAt, reason }
//
// ⚠️ FUSEAU HORAIRE — CONCEPTION ROBUSTE (2026-07-23) :
// Deux notions de temps sont volontairement séparées :
//  • createdUtc = heure de création Smoobu (convertie Berlin→UTC) → sert UNIQUEMENT
//    à la DÉTECTION (Smoobu a-t-il déjà envoyé ? la résa est-elle dans sa fenêtre ?).
//    Comparaisons à large marge : une erreur de fuseau ne change pas la décision.
//  • anchorUtc = NOTRE horloge serveur au moment où on voit la résa (webhook/scan) →
//    sert au DÉLAI d'envoi (B-LM = anchor+7min). C'est du temps UTC absolu produit
//    par NOTRE serveur : il ne dépend d'AUCUN fuseau (ni Maroc, ni Europe été/hiver).
//    → Même si le Maroc ou l'Europe changent d'heure, le délai reste exact.
function decideBlm(resa, createdUtc, now, anchorUtc) {
  const anchor = anchorUtc || createdUtc;
  if (createdUtc < LAUNCH_EPOCH) return { action: 'skip', reason: 'pre-launch' };
  if (!resa.checkin) return { action: 'skip', reason: 'no-checkin' };
  const expiry = dayAtUtc(resa.checkin, 1, { h: 6, m: 0 }); // pertinent jusqu'au lendemain 6h UTC
  if (now >= expiry) return { action: 'skip', reason: 'expired' };
  const b0 = dayAtUtc(resa.checkin, -2, B_WIN_START_UTC);
  const b1 = dayAtUtc(resa.checkin, -2, B_SAFE_END_UTC);
  if (createdUtc < b0) return { action: 'skip', reason: 'smoobu-in-time' };
  if (createdUtc <= b1) {
    // zone ambiguë : Smoobu a peut-être envoyé → différer après la fin sûre,
    // le contrôle conversation tranchera
    return { action: 'schedule', dueAt: new Date(Math.max(now.getTime(), b1.getTime() + 10 * 60000)), reason: 'ambiguous-window' };
  }
  // Délai ancré sur NOTRE horloge (réception) → +7 min : laisse le Welcome Smoobu
  // (2-5 min après la résa) partir en premier ; avec le cron 5 min → envoi effectif
  // ~7-12 min après la résa. 100% immunisé aux changements de fuseau.
  return { action: 'schedule', dueAt: new Date(Math.max(now.getTime(), anchor.getTime() + BLM_DELAY_MS)), reason: 'missed-window' };
}

function decideDepart(resa, createdUtc, now, anchorUtc) {
  const anchor = anchorUtc || createdUtc;
  if (createdUtc < LAUNCH_EPOCH) return { action: 'skip', reason: 'pre-launch' };
  if (!resa.checkout) return { action: 'skip', reason: 'no-checkout' };
  const expiry = dayAtUtc(resa.checkout, 0, { h: 9, m: 0 }); // avant ~10h locale le jour du départ
  if (now >= expiry) return { action: 'skip', reason: 'expired' };
  const d0 = dayAtUtc(resa.checkout, -1, D_WIN_START_UTC);
  const d1 = dayAtUtc(resa.checkout, -1, D_SAFE_END_UTC);
  if (createdUtc < d0) return { action: 'skip', reason: 'smoobu-in-time' };
  // ~1h après le B-LM (ancré sur notre horloge), jamais avant la fin sûre de la
  // fenêtre Smoobu J-1 (d1, plancher légitime qui peut être plus tard).
  const dueAt = new Date(Math.max(anchor.getTime() + DEPART_DELAY_MS, d1.getTime(), now.getTime()));
  return { action: 'schedule', dueAt, reason: 'missed-window' };
}

// ── Anti-doublon : un message équivalent existe-t-il déjà ? ───
// Cherche dans la conversation Smoobu un message HÔTE postérieur à la création
// de la résa qui ressemble au message qu'on s'apprête à envoyer (envoyé par
// Smoobu, par Hakim via le template manuel 1-clic, ou par un run précédent).
const BLM_MARKERS    = /guest\.smoobu\.com|check-?in en ligne|online check-?in|pr[ée]parer votre arriv[ée]e|prepare your arrival/i;
const DEPART_MARKERS = /d[ée]part pr[ée]vu le|departure information|avant 11h|before 11/i;

async function alreadyInConversation(sid, kind, sinceUtc) {
  const msgs = await getConvMessages(sid);
  const re = kind === 'blm' ? BLM_MARKERS : DEPART_MARKERS;
  const since = sinceUtc ? sinceUtc.getTime() - 10 * 60000 : 0;
  for (const m of msgs) {
    if (!isHostMessage(m)) continue;
    const d = msgDateUtc(m);
    if (d && d.getTime() < since) continue; // messages d'un séjour précédent etc.
    if (re.test(msgText(m))) return true;
  }
  return false;
}

// ── Templates : kb du logement ou fallback ────────────────────
async function getTemplates(appart) {
  try {
    const rows = await sbGet(`logements?nom=eq.${encodeURIComponent(appart)}&select=kb&limit=1`);
    const kb = rows?.[0]?.kb || {};
    return {
      blm:    (kb.msg_lastminute || '').trim() || FALLBACK_BLM,
      depart: (kb.msg_depart || '').trim() || FALLBACK_DEPART,
    };
  } catch {
    return { blm: FALLBACK_BLM, depart: FALLBACK_DEPART };
  }
}

function fillTemplate(tpl, ctx) {
  return tpl
    .replace(/\{prenom\}/g, ctx.prenom)
    .replace(/\{date_depart\}/g, ctx.dateDepart)
    .replace(/\{checkin_url\}/g, ctx.checkinUrl)
    .replace(/\{guide\}/g, ctx.guide);
}

// ── Charger les résas candidates ──────────────────────────────
const RESA_SELECT = 'select=id,smoobu_id,appart,voyageur,checkin,checkout,source,type_norm,statut,date_creation';
const APPART_IN = `appart=in.(${APPARTS_VALIDES.map((a) => `"${a}"`).join(',')})`;

function ymdOffset(now, d) {
  const t = new Date(now.getTime() + d * 86400000);
  return t.toISOString().slice(0, 10);
}

async function loadCandidates(now, onlySid) {
  if (onlySid) {
    return sbGet(`resa?smoobu_id=eq.${encodeURIComponent(onlySid)}&${RESA_SELECT}`);
  }
  const orFilter = `or=(and(checkin.gte.${ymdOffset(now, -1)},checkin.lte.${ymdOffset(now, 3)}),and(checkout.gte.${ymdOffset(now, 0)},checkout.lte.${ymdOffset(now, 2)}))`;
  return sbGet(
    `resa?smoobu_id=not.is.null&type_norm=in.(RESERVATION,RELOCATION)&statut=neq.Annulé&${encodeURI(APPART_IN)}&${orFilter}&${RESA_SELECT}&limit=100`
  );
}

function resaEligible(resa) {
  if (!resa || !resa.smoobu_id) return false;
  if (APPARTS_VALIDES.indexOf(resa.appart) === -1) return false;
  if (['RESERVATION', 'RELOCATION'].indexOf(resa.type_norm) === -1) return false;
  if (resa.statut === 'Annulé') return false;
  return true;
}

// ── PHASE 1 : scan → créer les décisions manquantes ───────────
async function scanPhase(now, onlySid, report) {
  const candidates = (await loadCandidates(now, onlySid)) || [];
  if (!candidates.length) return;

  const sids = candidates.map((r) => `"${String(r.smoobu_id)}"`).join(',');
  const existing = await sbGet(
    `scheduled_messages?smoobu_id=in.(${encodeURIComponent(sids).replace(/%2C/g, ',')})&select=smoobu_id,kind`
  );
  const seen = new Set((existing || []).map((e) => `${e.smoobu_id}|${e.kind}`));

  for (const resa of candidates) {
    if (!resaEligible(resa)) continue;
    const sid = String(resa.smoobu_id);
    const needBlm    = !seen.has(`${sid}|blm`);
    const needDepart = !seen.has(`${sid}|depart`);
    if (!needBlm && !needDepart) continue;

    const booking = await getBooking(sid);
    if (!booking || booking['is-blocked-booking']) continue;
    if (/cancel/i.test(String(booking.type || ''))) continue;
    const createdUtc = createdAtUtc(booking) || now;

    // anchor = notre horloge (première fois qu'on voit la résa ≈ heure réelle de
    // création, à quelques secondes près via webhook/scan) → délai fuseau-proof.
    const decisions = [];
    if (needBlm)    decisions.push(['blm',    decideBlm(resa, createdUtc, now, now)]);
    if (needDepart) decisions.push(['depart', decideDepart(resa, createdUtc, now, now)]);

    for (const [kind, dec] of decisions) {
      const row = {
        id: uid(),
        smoobu_id: sid,
        kind,
        appart: resa.appart,
        voyageur: resa.voyageur,
        due_at: (dec.dueAt || now).toISOString(),
        statut: dec.action === 'skip' ? 'skipped' : 'scheduled',
        detail: dec.reason,
      };
      try {
        await sbFetch('scheduled_messages?on_conflict=smoobu_id,kind', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
          body: JSON.stringify(row),
        });
        report.scanned.push(`${sid}/${kind}:${row.statut}(${dec.reason})`);
      } catch (e) {
        console.error('[lastminute] insert decision error:', e.message);
      }
    }
  }
}

// ── PHASE 2 : traiter les envois dus ──────────────────────────
async function duePhase(now, dryrun, report) {
  const due = await sbGet(
    `scheduled_messages?statut=eq.scheduled&due_at=lte.${encodeURIComponent(now.toISOString())}&select=id,smoobu_id,kind,appart,voyageur,created_at&order=due_at.asc&limit=10`
  );
  for (const row of due || []) {
    try {
      const outcome = await processDueRow(row, now, dryrun);
      report.processed.push(`${row.smoobu_id}/${row.kind}:${outcome}`);
    } catch (e) {
      console.error('[lastminute] processing error:', row.smoobu_id, row.kind, e.message);
      await sbPatch('scheduled_messages', `id=eq.${row.id}`, {
        statut: 'error', detail: String(e.message).slice(0, 300),
      }).catch(() => {});
      report.processed.push(`${row.smoobu_id}/${row.kind}:error`);
    }
  }
}

async function processDueRow(row, now, dryrun) {
  const sid = String(row.smoobu_id);

  // 1. Re-valider contre l'état ACTUEL de la résa (annulation, dates modifiées)
  const rows = await sbGet(`resa?smoobu_id=eq.${encodeURIComponent(sid)}&${RESA_SELECT}&limit=1`);
  const resa = rows?.[0];
  if (!resa || !resaEligible(resa)) {
    await sbPatch('scheduled_messages', `id=eq.${row.id}`, { statut: 'cancelled', detail: 'resa annulée ou non éligible' });
    return 'cancelled';
  }
  const booking = await getBooking(sid);
  if (!booking || booking['is-blocked-booking'] || /cancel/i.test(String(booking.type || ''))) {
    await sbPatch('scheduled_messages', `id=eq.${row.id}`, { statut: 'cancelled', detail: 'annulée côté Smoobu' });
    return 'cancelled';
  }
  const createdUtc = createdAtUtc(booking) || now;
  // anchor STABLE = l'heure serveur d'insertion de la ligne (created_at), pour que
  // la re-validation ne re-décale jamais le délai (idempotent, fuseau-proof).
  const anchorUtc = row.created_at ? new Date(row.created_at) : createdUtc;

  // Recalcul avec les dates ACTUELLES (gère les modifications de dates)
  const dec = row.kind === 'blm' ? decideBlm(resa, createdUtc, now, anchorUtc) : decideDepart(resa, createdUtc, now, anchorUtc);
  if (dec.action === 'skip') {
    const st = dec.reason === 'smoobu-in-time' ? 'cancelled' : 'skipped';
    await sbPatch('scheduled_messages', `id=eq.${row.id}`, { statut: st, detail: `revalidation: ${dec.reason}` });
    return st;
  }
  if (dec.dueAt && dec.dueAt.getTime() > now.getTime() + 60000) {
    // dates repoussées → replanifier
    await sbPatch('scheduled_messages', `id=eq.${row.id}`, { due_at: dec.dueAt.toISOString(), detail: 'replanifié (dates modifiées)' });
    return 'rescheduled';
  }

  if (dryrun) return 'would-send';

  // 2. Claim atomique (anti-concurrence webhook + cron)
  const claimed = await sbPatch(
    'scheduled_messages', `id=eq.${row.id}&statut=eq.scheduled`,
    { statut: 'sending' }, 'return=representation'
  );
  if (!claimed || !claimed.length) return 'already-claimed';

  // 3. Anti-doublon : message équivalent déjà dans la conversation ?
  if (await alreadyInConversation(sid, row.kind, createdUtc)) {
    await sbPatch('scheduled_messages', `id=eq.${row.id}`, { statut: 'skipped', detail: 'message équivalent déjà présent dans la conversation' });
    return 'skipped-existing';
  }

  // 4. Construire le texte (template logement + données réelles)
  const tpls = await getTemplates(resa.appart);
  const guide = String(booking['guest-app-url'] || '').trim();
  const checkinUrl = row.kind === 'blm' ? await getOnlineCheckInUrl(sid, guide) : null;
  const ctx = {
    prenom: firstName(resa.voyageur || booking.firstname),
    dateDepart: frDate(resa.checkout),
    guide: guide || 'le lien reçu dans votre message de bienvenue',
    checkinUrl: checkinUrl || guide || 'le lien reçu dans votre message de bienvenue',
  };
  const text = fillTemplate(row.kind === 'blm' ? tpls.blm : tpls.depart, ctx);

  // 5. Envoyer via Smoobu + tracer dans la table messages (visible CRM)
  await sendSmoobuMessage(sid, text);
  const nowIso = new Date().toISOString();
  try {
    await sbInsert('messages', {
      id: uid(),
      smoobu_booking_id: parseInt(sid, 10) || null,
      sender: 'host',
      message_content: text,
      sent_text: text,
      statut: 'sent',
      client_summary_fr: row.kind === 'blm'
        ? '🕐 Envoi auto last-minute — instructions d\'arrivée (B-LM)'
        : '🕐 Envoi auto last-minute — informations de départ',
      voyageur: resa.voyageur,
      appart: resa.appart,
      source: resa.source,
      created_at: nowIso,
      updated_at: nowIso,
    });
  } catch (e) {
    console.error('[lastminute] trace messages insert error (envoi OK):', e.message);
  }
  await sbPatch('scheduled_messages', `id=eq.${row.id}`, { statut: 'sent', sent_at: nowIso });
  console.log(`[lastminute] SENT ${row.kind} → booking ${sid} (${resa.voyageur} / ${resa.appart})`);
  return 'sent';
}

// ── PHASE 3 : annuler les lignes planifiées des résas annulées ─
async function cancelPhase(report) {
  const sched = await sbGet(
    `scheduled_messages?statut=eq.scheduled&select=id,smoobu_id,kind&limit=100`
  );
  if (!sched || !sched.length) return;
  const sids = [...new Set(sched.map((s) => String(s.smoobu_id)))];
  const inList = sids.map((s) => `"${s}"`).join(',');
  const resas = await sbGet(
    `resa?smoobu_id=in.(${encodeURIComponent(inList).replace(/%2C/g, ',')})&select=smoobu_id,statut,type_norm`
  );
  const bad = new Set(
    (resas || [])
      .filter((r) => r.statut === 'Annulé' || String(r.type_norm || '').indexOf('ANNULATION') === 0)
      .map((r) => String(r.smoobu_id))
  );
  for (const s of sched) {
    if (bad.has(String(s.smoobu_id))) {
      await sbPatch('scheduled_messages', `id=eq.${s.id}`, { statut: 'cancelled', detail: 'résa annulée' }).catch(() => {});
      report.cancelled.push(`${s.smoobu_id}/${s.kind}`);
    }
  }
}

// ── Handler principal ─────────────────────────────────────────
module.exports = async function handler(req, res) {
  const q = req.query || {};

  if (req.method === 'GET' && q.status) {
    try {
      const rows = await sbGet(
        'scheduled_messages?select=smoobu_id,kind,appart,voyageur,due_at,statut,detail,sent_at&order=created_at.desc&limit=40'
      );
      return res.status(200).json({ ok: true, rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const dryrun  = !!q.dryrun;
  const onlySid = q.booking ? String(q.booking) : null;
  const now     = new Date();
  const report  = { scanned: [], processed: [], cancelled: [], dryrun };

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY || !process.env.SMOOBU_API_KEY) {
      return res.status(500).json({ error: 'Variables d\'environnement manquantes' });
    }
    await scanPhase(now, onlySid, report);
    await cancelPhase(report);
    await duePhase(now, dryrun, report);

    // Heartbeat (visible en base, cohérent avec le pattern existant)
    try {
      await sbFetch('sync_heartbeat?on_conflict=id', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify({ id: 'lastminute-run', last_run: now.toISOString(), detail: `s:${report.scanned.length} p:${report.processed.length}` }),
      });
    } catch (e) { /* non bloquant */ }

    return res.status(200).json({ ok: true, ...report });
  } catch (e) {
    console.error('[lastminute] run error:', e.message, e);
    return res.status(500).json({ error: e.message, ...report });
  }
};
