// ============================================================
// /api/smoobu-poll.js — Nex-Estate CRM
// Synchro Smoobu → Supabase avec protection override_manual
//
// Comportement :
//   - Fetch les réservations modifiées depuis POLL_WINDOW_HOURS
//   - Supporte ?from=YYYY-MM-DD pour backfill manuel (override fenêtre auto)
//   - Pour chaque réservation Smoobu :
//     A. Si smoobu_id inexistant en base → INSERT
//     B. Si smoobu_id existe + override_manual=true → UPDATE partiel
//        (voyageur, dates, nuits uniquement — finances protégées)
//     C. Si smoobu_id existe + override_manual=false → UPDATE complet
//   - Si voyageur vide après mapping → appel individuel GET /reservations/{id}
//
// Variables d'environnement requises :
//   SMOOBU_API_KEY     — clé API Smoobu
//   SUPABASE_URL       — https://xxxx.supabase.co
//   SUPABASE_KEY       — service_role key (accès complet)
//   POLL_WINDOW_HOURS  — fenêtre de polling en heures (défaut: 25)
//   CRON_SECRET        — secret pour sécuriser les appels cron (optionnel)
// ============================================================

const POLL_WINDOW_HOURS = parseInt(process.env.POLL_WINDOW_HOURS || '25');
const SMOOBU_API        = 'https://login.smoobu.com/api';
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Taux de commission par source (fallback si non fourni par Smoobu)
const COM = { Airbnb: 0.155, 'Booking.com': 0.22, Direct: 0, VRBO: 0.18 };
const APPARTS = ['Résidence Al Boustane','Agdal 13','Touahri 11','Riad Ahl Sala'];
const RABAT   = ['Résidence Al Boustane','Agdal 13'];
const TAUX    = { rabat: 4, sale: 2 };

// ── Helpers ──────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normDate(raw) {
  if (!raw) return '';
  const s = raw.trim().split('T')[0];
  const p = s.split(/[-\/\.]/);
  if (p.length !== 3) return '';
  if (p[0].length === 4) return `${p[0]}-${p[1].padStart(2,'0')}-${p[2].padStart(2,'0')}`;
  const yr = p[2].length === 2 ? '20' + p[2] : p[2];
  return `${yr}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
}

function diffNuits(ci, co) {
  if (!ci || !co) return 0;
  return Math.max(0, Math.round((new Date(co) - new Date(ci)) / 86400000));
}

function detectSrc(raw) {
  const lw = (raw || '').toLowerCase();
  if (lw.includes('airbnb')) return 'Airbnb';
  if (lw.includes('booking')) return 'Booking.com';
  if (lw.includes('vrbo') || lw.includes('homeaway')) return 'VRBO';
  return 'Direct';
}

function detectAp(raw) {
  if (!raw) return '';
  const lw = raw.toLowerCase();
  if (lw.includes('boustane') || lw.includes('nahda')) return 'Résidence Al Boustane';
  if (lw.includes('agdal') || lw.includes('biognache')) return 'Agdal 13';
  if (lw.includes('touahri')) return 'Touahri 11';
  if (lw.includes('riad') || lw.includes('ahl') || lw.includes('sala')) return 'Riad Ahl Sala';
  return raw;
}

function nextThursday(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const day = d.getDay();
  const daysToAdd = day === 0 ? 4 : day <= 3 ? 4 - day : 4 + (7 - day);
  d.setDate(d.getDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
}

function calcDatePaiement(src, typeNorm, ci, co, dateCreation) {
  const t = new Date().toISOString().slice(0, 10);
  if (typeNorm === 'ANNULATION_NON_PAYEE') return dateCreation || t;
  if (src === 'Airbnb') {
    if (!ci) return dateCreation || t;
    const d = new Date(ci); d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (src === 'Booking.com') return nextThursday(co) || dateCreation || t;
  if (src === 'VRBO') {
    if (!ci) return dateCreation || t;
    const d = new Date(ci); d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  return dateCreation || t;
}

function tauxTaxe(appart) {
  return RABAT.includes(appart) ? TAUX.rabat : TAUX.sale;
}

// ── Supabase helpers ──────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${path} ${res.status}: ${text}`);
  }
  if (res.status === 204 || opts.method === 'PATCH' || opts.method === 'POST') return null;
  return res.json();
}

async function sbGet(path) {
  return sbFetch(path, { method: 'GET', headers: { 'Prefer': 'return=representation' } });
}

async function sbUpsert(table, row) {
  return sbFetch(`${table}?on_conflict=id`, {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

async function sbPatch(table, id, fields) {
  return sbFetch(`${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify(fields),
  });
}

// ── Mapper Smoobu booking → CRM row ──────────────────────────

function mapSmoobuBooking(b) {
  // Les champs Smoobu API sont hyphenated/lowercase (ex: 'guest-name', 'reference-id')
  if (b['is-blocked-booking'] === true) return null;

  const src  = detectSrc((b.channel && b.channel.name) || b.type || '');
  const ap   = detectAp((b.apartment && b.apartment.name) || '');
  const ci   = normDate(b.arrival || '');
  const co   = normDate(b.departure || '');
  const smoobuId = String(b.id);
  const dateCreation = normDate(b['created-at'] || b.createdAt || b.created_at || '');

  const prixEur = parseFloat(b.price || 0);
  const nuits   = parseInt(b.nights || '') || diffNuits(ci, co) || 0;
  const adultes = parseInt(b.adults || 1) || 1;
  const enfants = parseInt(b.children || 0) || 0;

  // Type normalisé
  const statRaw = (b.type || b.status || '').toLowerCase();
  const isAnnule = statRaw.includes('cancel') || statRaw.includes('annul');
  let typeNorm;
  if (isAnnule) {
    typeNorm = prixEur > 0 ? 'ANNULATION_PAYEE' : 'ANNULATION_NON_PAYEE';
  } else {
    typeNorm = 'RESERVATION';
  }

  const nuitsFact  = (typeNorm === 'RESERVATION' || typeNorm === 'ANNULATION_PAYEE') ? nuits : 0;
  const nuitsSejou = typeNorm === 'RESERVATION' ? nuits : 0;

  // Commission — Smoobu renvoie 'commission-included' en POURCENTAGE (22.0 = 22%)
  let comPct, comEurFinal;
  const comRaw = parseFloat(b['commission-included'] || b.commission || 0);
  if (comRaw > 0 && comRaw <= 100) {
    comPct      = comRaw / 100;
    comEurFinal = prixEur * comPct;
  } else {
    comPct      = COM[src] || 0;
    comEurFinal = prixEur * comPct;
  }
  let netEur = prixEur - comEurFinal;
  if (typeNorm === 'ANNULATION_NON_PAYEE') {
    netEur = 0; comEurFinal = 0; comPct = 0;
  }

  // Taxe
  let taxeEur = parseFloat(b['city-tax'] || b.cityTax || b.city_tax || 0);
  if (!taxeEur && src === 'Booking.com' && nuitsSejou > 0 && ap) {
    taxeEur = nuitsSejou * adultes * tauxTaxe(ap);
  }

  const dp = calcDatePaiement(src, typeNorm, ci, co, dateCreation);
  const today = new Date().toISOString().slice(0, 10);
  const statut = typeNorm === 'ANNULATION_NON_PAYEE' ? 'Annulé'
    : (dp && today >= dp) ? 'Payé' : 'En attente';

  // Ref plateforme — 'reference-id' est le champ natif Smoobu
  const refPlateforme = b['reference-id'] || b.referenceId || '';
  const notesRaw = b.notice || b.note || b.notes || '';
  const mRef = notesRaw.match(/Num[eé]ro de r[eé]servation[:\s]+([A-Za-z0-9]+)/i);
  const entryRef = refPlateforme || (mRef ? mRef[1] : smoobuId);

  // Voyageur — 'guest-name' est le champ natif, sinon firstname/lastname (lowercase)
  const voyageur = b['guest-name'] ||
    [b.firstname, b.lastname].filter(Boolean).join(' ').trim() ||
    [b.firstName, b.lastName].filter(Boolean).join(' ').trim() || '';

  if (!voyageur) {
    console.log(`[poll] WARN voyageur vide après mapping ${smoobuId} — clés reçues:`,
      Object.keys(b).filter(k => /name|guest|first|last/i.test(k)));
  }

  return {
    smoobu_id:      smoobuId,
    ref:            entryRef,
    source:         src,
    appart:         ap,
    voyageur,
    phone:          b.phone || null,
    email:          b.email || null,
    guest_language: b.language || null,
    adults:         adultes,
    children:       enfants,
    nb_personnes:   adultes,
    checkin:        ci,
    checkout:       co,
    nuits_sejour:   nuitsSejou,
    nuits_fact:     nuitsFact,
    brut:           Math.round(prixEur * 100) / 100,
    com_pct:        Math.round(comPct * 100000) / 100000,
    commission:     Math.round(comEurFinal * 100) / 100,
    net:            Math.round(netEur * 100) / 100,
    taxe_sejour:    Math.round(taxeEur * 100) / 100,
    type_norm:      typeNorm,
    mode_paiement:  'Virement plateforme',
    statut:         statut,
    date_creation:  dateCreation || null,
    date_paiement:  dp || null,
    mois_kpi:       (dp || ci).slice(0, 7),
    notes:          '',
    override_manual: false,
  };
}

// ── Enrichissement individuel Smoobu ──────────────────────────

async function enrichFromSmoobu(mapped, apiKey, stats) {
  try {
    const detailRes = await fetch(`${SMOOBU_API}/reservations/${mapped.smoobu_id}`, {
      headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' }
    });
    if (!detailRes.ok) {
      console.log(`[poll] WARNING enrichissement ${mapped.smoobu_id}: HTTP ${detailRes.status}`);
      stats.warnings++;
      return;
    }
    const detail = await detailRes.json();

    // Smoobu detail endpoint: mêmes champs hyphenated/lowercase que le listing
    const fullName = detail['guest-name'] ||
      [detail.firstname, detail.lastname].filter(Boolean).join(' ').trim() ||
      [detail.firstName, detail.lastName].filter(Boolean).join(' ').trim() || '';

    if (fullName) {
      mapped.voyageur = fullName;
      console.log(`[poll] ENRICHI voyageur ${mapped.smoobu_id}: "${fullName}"`);
    } else {
      console.log(`[poll] WARNING ${mapped.smoobu_id} vide même en détail — clés:`,
        Object.keys(detail).filter(k => /name|guest|first|last/i.test(k)));
      stats.warnings++;
    }

    // Ref plateforme : 'reference-id' est le champ natif Smoobu
    const refDetail = detail['reference-id'] || detail.referenceId || detail.reference || '';
    if (mapped.ref === mapped.smoobu_id && refDetail) {
      mapped.ref = refDetail;
      console.log(`[poll] ENRICHI ref ${mapped.smoobu_id}: "${refDetail}"`);
    }
  } catch (err) {
    console.log(`[poll] WARNING enrichissement ${mapped.smoobu_id}: ${err.message}`);
    stats.warnings++;
  }
}

// ── Handler principal ─────────────────────────────────────────

export default async function handler(req, res) {
  // Sécurisation optionnelle par secret
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_KEY manquants' });
  }
  if (!process.env.SMOOBU_API_KEY) {
    return res.status(500).json({ error: 'SMOOBU_API_KEY manquant' });
  }

  // ?probe=SMOOBU_ID — retourne le JSON brut du détail pour diagnostiquer les champs
  const probeId = req.query?.probe;
  if (probeId) {
    const pr = await fetch(`${SMOOBU_API}/reservations/${probeId}`, {
      headers: { 'Api-Key': process.env.SMOOBU_API_KEY, 'Content-Type': 'application/json' }
    });
    const raw = await pr.json();
    return res.json({ probe: probeId, status: pr.status, keys: Object.keys(raw), raw });
  }

  // Fenêtre temporelle — ?from=YYYY-MM-DD override la fenêtre automatique (backfill)
  const fromParam = req.query?.from;
  let modifiedFrom;
  if (fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam)) {
    modifiedFrom = `${fromParam} 00:00:00`;
    console.log('[poll] démarrage — backfill depuis:', modifiedFrom);
  } else {
    const fromDate = new Date(Date.now() - POLL_WINDOW_HOURS * 3600_000);
    modifiedFrom = fromDate.toISOString().slice(0, 19).replace('T', ' ');
    console.log('[poll] démarrage — fenêtre auto:', modifiedFrom);
  }

  // 1. Fetch Smoobu
  const smoobuUrl = `${SMOOBU_API}/reservations?modifiedFrom=${encodeURIComponent(modifiedFrom)}&pageSize=100&showCancellation=true`;
  let smoobuRes;
  try {
    smoobuRes = await fetch(smoobuUrl, {
      headers: { 'Api-Key': process.env.SMOOBU_API_KEY, 'Content-Type': 'application/json' }
    });
    if (!smoobuRes.ok) throw new Error(`Smoobu ${smoobuRes.status}`);
  } catch (err) {
    console.error('[poll] Smoobu fetch error:', err.message);
    return res.status(502).json({ error: 'Smoobu API unreachable', detail: err.message });
  }

  const smoobuData = await smoobuRes.json();
  const bookings = smoobuData.reservations || smoobuData.bookings || smoobuData.data || [];
  console.log(`[poll] ${bookings.length} réservations Smoobu reçues`);

  if (!bookings.length) {
    return res.json({ ok: true, modifiedFrom, stats: { fetched: 0, skipped: 0, warnings: 0, errors: 0, upserted: 0 } });
  }

  // 2. Charger les enregistrements existants par smoobu_id
  const smoobuIds = bookings.map(b => String(b.id));
  const existing = await sbGet(`resa?smoobu_id=in.(${smoobuIds.join(',')})&select=id,smoobu_id,override_manual`);
  const existingMap = {};
  (existing || []).forEach(r => { existingMap[r.smoobu_id] = r; });

  const stats = { fetched: bookings.length, skipped: 0, warnings: 0, errors: 0, upserted: 0, enriched: 0 };

  // 3. Traiter chaque réservation
  for (const b of bookings) {
    try {
      const mapped = mapSmoobuBooking(b);
      if (!mapped) { stats.skipped++; continue; } // is-blocked-booking
      const smoobuId = mapped.smoobu_id;

      // Enrichissement individuel si voyageur vide après mapping
      if (!mapped.voyageur) {
        const warnsBefore = stats.warnings;
        await enrichFromSmoobu(mapped, process.env.SMOOBU_API_KEY, stats);
        if (mapped.voyageur) stats.enriched++;
      }

      const rec = existingMap[smoobuId];

      if (!rec) {
        // ── A. Nouvelle réservation → INSERT ──
        await sbUpsert('resa', { ...mapped, id: uid() });
        stats.upserted++;
        console.log(`[poll] INSERT ${smoobuId}`);

      } else if (rec.override_manual) {
        // ── B. Protégé → UPDATE partiel (champs non-financiers uniquement) ──
        await sbPatch('resa', rec.id, {
          checkin:      mapped.checkin,
          checkout:     mapped.checkout,
          voyageur:     mapped.voyageur,
          adults:       mapped.adults,
          children:     mapped.children,
          nb_personnes: mapped.nb_personnes,
          appart:       mapped.appart,
          source:       mapped.source,
          phone:        mapped.phone,
          email:        mapped.email,
          nuits_sejour: mapped.nuits_sejour,
          nuits_fact:   mapped.nuits_fact,
          // Champs financiers conservés : brut, net, commission, com_pct,
          // statut, type_norm, date_paiement, mois_kpi, notes, taxe_sejour
        });
        stats.skipped++;
        console.log(`[poll] PARTIAL ${smoobuId} (override_manual=true — finances protégées)`);

      } else {
        // ── C. Mise à jour complète → UPDATE (même id) ──
        await sbUpsert('resa', { ...mapped, id: rec.id, override_manual: false });
        stats.upserted++;
        console.log(`[poll] UPDATE ${smoobuId}`);
      }
    } catch (err) {
      stats.errors++;
      console.error(`[poll] ERROR booking ${b.id}:`, err.message);
    }
  }

  console.log('[poll] terminé:', JSON.stringify(stats));
  return res.json({ ok: true, modifiedFrom, stats });
}
