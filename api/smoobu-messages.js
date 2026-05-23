// ============================================================
// /api/smoobu-messages.js — Nex-Estate CRM
// Module messagerie IA : réception webhook Smoobu + envoi validé
//
// Endpoints :
//   POST (no query)  → webhook Smoobu action:newMessage
//                      → lit le message, génère brouillon IA, INSERT messages
//   POST ?send=1     → envoie la réponse validée via Smoobu API
//                      → UPDATE statut='sent'
//   GET  ?probe=1    → health check
//
// Variables d'environnement requises :
//   SUPABASE_URL              → https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY → clé service_role (bypass RLS)
//   SMOOBU_API_KEY            → clé API Smoobu
//   OPENAI_API_KEY            → clé OpenAI API (brouillon IA)
//
// Configurer dans Smoobu :
//   Settings → Advanced → API Keys → Webhook URLs
//   Ajouter : https://nex-estate-seven.vercel.app/api/smoobu-messages
//   NE PAS remplacer le webhook existant — Smoobu accepte plusieurs URLs
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMOOBU_KEY   = process.env.SMOOBU_API_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const SMOOBU_API   = 'https://login.smoobu.com/api';

// ── Supabase REST (service_role — bypass RLS) ─────────────────
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
  if (!res.ok) throw new Error(`Supabase [${path}]: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function sbGet(path) {
  return sbFetch(path, { method: 'GET' });
}

async function sbInsert(table, row) {
  return sbFetch(table, {
    method:  'POST',
    headers: { 'Prefer': 'return=minimal' },
    body:    JSON.stringify(row),
  });
}

async function sbPatch(table, filter, patch) {
  return sbFetch(`${table}?${filter}`, {
    method:  'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body:    JSON.stringify(patch),
  });
}

// ── Smoobu : lire les messages d'une réservation ──────────────
async function getSmoobuMessages(bookingId) {
  const res = await fetch(`${SMOOBU_API}/reservations/${bookingId}/messages`, {
    headers: { 'Api-Key': SMOOBU_KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Smoobu GET messages [${bookingId}]: ${res.status} ${err}`);
  }
  return res.json();
}

// ── Smoobu : envoyer un message au voyageur ───────────────────
async function sendSmoobuMessage(bookingId, text) {
  const res = await fetch(`${SMOOBU_API}/reservations/${bookingId}/messages`, {
    method:  'POST',
    headers: { 'Api-Key': SMOOBU_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message: text, to: 'guest' }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Smoobu POST message [${bookingId}]: ${res.status} ${err}`);
  }
  return res.json();
}

// ── OpenAI API : générer un brouillon de réponse ─────────────
async function generateDraft(ctx) {
  const { appart, voyageur, checkin, checkout, source, message_content } = ctx;

  const systemPrompt =
    'Tu es l\'assistant de Hakim, hôte de locations courte durée à Rabat et Salé (Maroc), ' +
    'société Nex-Estate. Réponds au message du voyageur de façon professionnelle, ' +
    'courte, chaleureuse et claire. Langue : celle du voyageur. ' +
    'Règles strictes : pas d\'emojis, ne jamais inventer d\'information, ' +
    'si une information est manquante ou incertaine écrire "je vérifie et reviens vers vous", ' +
    'ne jamais envoyer de confirmation définitive sans avoir vérifié côté hôte. ' +
    'Rédige uniquement la réponse, sans introduction ni explication.';

  const userPrompt =
    `Logement : ${appart    || 'non précisé'}\n` +
    `Voyageur : ${voyageur  || 'non précisé'}\n` +
    `Check-in : ${checkin   || 'non précisé'}\n` +
    `Check-out : ${checkout || 'non précisé'}\n` +
    `Plateforme : ${source  || 'non précisé'}\n\n` +
    `Message du voyageur :\n${message_content}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:      'gpt-4o-mini',
      max_tokens: 512,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ── Enrichir depuis la table resa (via smoobu_id) ────────────
// Retourne { id, appart, voyageur, source, checkin, checkout } ou {}
async function getResaContext(smoobuBookingId) {
  try {
    const sid  = encodeURIComponent(String(smoobuBookingId));
    const rows = await sbGet(
      `resa?smoobu_id=eq.${sid}&select=id,appart,voyageur,source,checkin,checkout&limit=1`
    );
    return rows?.[0] || {};
  } catch {
    return {};
  }
}

// ── Déduplication : vérifier si ce message existe déjà ────────
// Niveau 1 : si smoobu_message_id connu → vérification exacte
// Niveau 2 : fallback contenu + fenêtre 5 minutes sur même booking
async function checkDuplicate(smoobuBookingId, messageContent, smoobuMessageId) {
  try {
    if (smoobuMessageId) {
      const rows = await sbGet(
        `messages?smoobu_message_id=eq.${encodeURIComponent(smoobuMessageId)}&select=id&limit=1`
      );
      return (rows?.length || 0) > 0;
    }

    // Fallback : fenêtre 5 minutes, même booking, contenu identique (200 premiers chars)
    const since = encodeURIComponent(new Date(Date.now() - 5 * 60 * 1000).toISOString());
    const rows  = await sbGet(
      `messages?smoobu_booking_id=eq.${smoobuBookingId}&created_at=gte.${since}&select=id,message_content&limit=10`
    );
    if (!rows?.length) return false;
    const prefix = messageContent.trim().slice(0, 200);
    return rows.some(function(r) {
      return (r.message_content || '').trim().slice(0, 200) === prefix;
    });
  } catch {
    // Si la vérif échoue, on laisse passer (mieux un doublon qu'un message perdu)
    return false;
  }
}

// ── Extraire le texte brut d'un message Smoobu ───────────────
// Smoobu retourne : message (plain) + htmlMessage (html) + content/body/text en fallback
function extractMessageText(msg) {
  var text = msg.message || msg.htmlMessage || msg.content || msg.body || msg.text || '';
  return String(text).trim();
}

// ── Extraire l'ID natif Smoobu du message (si disponible) ────
function extractSmoobuMessageId(msg) {
  const raw = msg.id || msg.messageId || msg.message_id || msg.messageID || '';
  const str = String(raw).trim();
  return str || null;
}

// ── Détecter si un message vient du voyageur ─────────────────
// Smoobu retourne type comme entier : 1 = guest, 2 = host
// Fallback string pour d'autres versions d'API
function isGuestMessage(msg) {
  // Cas numérique Smoobu : type 1 = guest, type 2 = host
  if (typeof msg.type === 'number') {
    return msg.type === 1;
  }
  // Cas string / objet (autres formats API)
  var candidate = msg.type || msg.sender || msg.from || msg.role;
  if (candidate && typeof candidate === 'object') {
    candidate = candidate.type || candidate.role || candidate.name || '';
  }
  var sender = String(candidate == null ? '' : candidate).toLowerCase();
  return sender === 'guest' || sender === 'traveler' || sender === 'traveller' ||
         sender === 'received' || sender === 'customer';
}

// ── Générer un ID unique (même pattern que le CRM) ───────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Insérer un record d'erreur (non bloquant) ────────────────
async function insertErrorRecord(bookingId, errMsg, rawPayload) {
  try {
    const now = new Date().toISOString();
    await sbInsert('messages', {
      id:                uid(),
      smoobu_booking_id: bookingId,
      sender:            'guest',
      message_content:   '(erreur de traitement webhook)',
      statut:            'error',
      error_message:     String(errMsg).slice(0, 500),
      raw_payload:       rawPayload || null,
      created_at:        now,
      updated_at:        now,
    });
  } catch (e) {
    console.error('[messages] insertErrorRecord failed:', e.message);
  }
}

// ============================================================
// Handler principal Vercel
// ============================================================
export default async function handler(req, res) {

  // ── Health check ─────────────────────────────────────────
  if (req.method === 'GET' && req.query?.probe) {
    return res.status(200).json({ ok: true, service: 'smoobu-messages' });
  }

  // ── Debug temporaire : voir le format raw Smoobu messages ─
  // GET ?debug_booking=ID → retourne les messages bruts (à supprimer après diagnostic)
  if (req.method === 'GET' && req.query?.debug_booking) {
    if (!SMOOBU_KEY) return res.status(500).json({ error: 'SMOOBU_API_KEY manquante' });
    try {
      const raw = await getSmoobuMessages(req.query.debug_booking);
      const all = raw?.messages || raw?.data || (Array.isArray(raw) ? raw : []);
      return res.status(200).json({ count: all.length, first3: all.slice(0, 3), raw_keys: all[0] ? Object.keys(all[0]) : [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !SMOOBU_KEY) {
    console.error('[messages] Variables d\'environnement manquantes (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SMOOBU_API_KEY)');
    return res.status(500).json({ error: 'Variables d\'environnement manquantes' });
  }

  // ── Mode envoi : POST ?send=1 ─────────────────────────────
  // Appelé par le frontend CRM après validation manuelle de Hakim.
  // La clé SMOOBU_API_KEY reste côté serveur uniquement.
  if (req.query?.send) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { message_id, text } = body || {};

      if (!message_id || !String(message_id).trim()) {
        return res.status(400).json({ error: 'message_id requis' });
      }
      if (!text || !String(text).trim()) {
        return res.status(400).json({ error: 'text requis — le brouillon est vide' });
      }

      // Lire le message en base pour vérifier statut et récupérer booking_id
      const rows = await sbGet(
        `messages?id=eq.${encodeURIComponent(message_id)}&select=id,smoobu_booking_id,statut&limit=1`
      );
      const msg = rows?.[0];
      if (!msg) {
        return res.status(404).json({ error: 'Message introuvable en base' });
      }
      if (msg.statut === 'sent') {
        return res.status(409).json({ error: 'Message déjà envoyé — doublon bloqué' });
      }
      if (msg.statut === 'ignored') {
        return res.status(409).json({ error: 'Message ignoré — impossible d\'envoyer' });
      }

      // Envoyer via Smoobu API (clé serveur, jamais exposée au frontend)
      await sendSmoobuMessage(msg.smoobu_booking_id, String(text).trim());

      // Marquer comme envoyé en base
      const now = new Date().toISOString();
      await sbPatch('messages', `id=eq.${encodeURIComponent(message_id)}`, {
        statut:    'sent',
        ai_draft:  String(text).trim(),
        sent_at:   now,
        updated_at: now,
      });

      console.log('[messages] sent OK — message_id:', message_id, '| booking_id:', msg.smoobu_booking_id);
      return res.status(200).json({ ok: true, sent: true, message_id });

    } catch (err) {
      console.error('[messages] send error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Mode webhook : réception newMessage depuis Smoobu ─────
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Body JSON invalide' });
  }

  const { action, data: booking } = payload || {};
  console.log('[messages] action:', action, '| booking_id:', booking?.id);

  // Ignorer silencieusement les autres actions Smoobu (newReservation, etc.)
  // → Smoobu reçoit un 200 et ne retente pas
  if (action !== 'newMessage') {
    return res.status(200).json({ ok: true, skipped: `action ignorée: ${action}` });
  }

  if (!booking?.id) {
    return res.status(400).json({ error: 'booking.id manquant dans le payload Smoobu' });
  }

  try {
    // 1. Lire les messages complets de la réservation via Smoobu
    const msgData = await getSmoobuMessages(booking.id);

    // Smoobu peut retourner { messages: [...] }, { data: [...] } ou [...]
    const allMessages = (
      msgData?.messages ||
      msgData?.data     ||
      (Array.isArray(msgData) ? msgData : [])
    );

    console.log('[messages] nb_msgs:', allMessages.length, '| booking:', booking.id);

    // Trouver le dernier message du voyageur avec contenu non vide
    const guestMessages = allMessages.filter(function(m) {
      return isGuestMessage(m) && extractMessageText(m).length > 0;
    });
    const lastMsg = guestMessages[guestMessages.length - 1];

    if (!lastMsg) {
      console.log('[messages] Aucun message voyageur — booking:', booking.id);
      return res.status(200).json({ ok: true, skipped: 'no_guest_message' });
    }

    const messageContent    = extractMessageText(lastMsg);
    const smoobuMessageId   = extractSmoobuMessageId(lastMsg);

    if (!messageContent) {
      console.log('[messages] Message voyageur vide — booking:', booking.id);
      return res.status(200).json({ ok: true, skipped: 'empty_message' });
    }

    // 2. Déduplication : éviter les doublons sur retry webhook
    const isDup = await checkDuplicate(booking.id, messageContent, smoobuMessageId);
    if (isDup) {
      console.log('[messages] Doublon détecté — booking:', booking.id, '| smoobu_msg_id:', smoobuMessageId, '| skipped');
      return res.status(200).json({ ok: true, skipped: 'duplicate' });
    }

    // 3. Enrichir depuis la table resa (appart, voyageur, source, dates, id CRM)
    const resaCtx = await getResaContext(booking.id);

    // Fallback sur les données brutes du webhook si resa non trouvée
    const guestName = resaCtx.voyageur ||
      [booking.guest?.firstname, booking.guest?.lastname].filter(Boolean).join(' ') ||
      booking.guestName || '';

    const appart  = resaCtx.appart   || booking.apartment?.name || '';
    const source  = resaCtx.source   || '';
    const checkin = resaCtx.checkin  || booking.arrivalDate   || '';
    const checkout= resaCtx.checkout || booking.departureDate || '';

    // 4. Générer le brouillon IA via OpenAI (erreur non bloquante)
    let aiDraft = '';
    if (OPENAI_KEY) {
      try {
        aiDraft = await generateDraft({
          appart, voyageur: guestName, checkin, checkout, source,
          message_content: messageContent,
        });
      } catch (openaiErr) {
        console.error('[messages] OpenAI error:', openaiErr.message);
        aiDraft = '— Génération automatique échouée. Rédigez votre réponse ci-dessous. —';
      }
    } else {
      console.warn('[messages] OPENAI_API_KEY non configurée — brouillon vide');
    }

    // 5. INSERT dans la table messages (statut: pending)
    const now = new Date().toISOString();
    const newMsg = {
      id:                uid(),
      smoobu_booking_id: booking.id,
      reservation_id:    resaCtx.id    || null,   // C4 : id CRM de la resa liée
      appart:            appart        || null,
      voyageur:          guestName     || null,
      source:            source        || null,
      sender:            'guest',
      message_content:   messageContent,
      ai_draft:          aiDraft       || null,
      smoobu_message_id: smoobuMessageId || null,  // déduplication niveau 1
      raw_payload:       booking       || null,    // payload Smoobu brut pour debug
      statut:            'pending',
      created_at:        now,
      updated_at:        now,
    };

    await sbInsert('messages', newMsg);
    console.log('[messages] INSERT OK — booking:', booking.id, '| appart:', appart, '| voyageur:', guestName, '| resa_id:', resaCtx.id || 'non liée');

    return res.status(200).json({ ok: true, action, message_id: newMsg.id });

  } catch (err) {
    // Distinguer doublon DB (UNIQUE violation) d'une vraie erreur
    const isDupViolation = err.message.includes('23505') || err.message.toLowerCase().includes('unique');
    if (isDupViolation) {
      console.log('[messages] Doublon DB (UNIQUE constraint) — booking:', booking.id);
      return res.status(200).json({ ok: true, skipped: 'duplicate_db' });
    }

    console.error('[messages] erreur traitement:', err.message, err);

    // Tenter d'insérer un record d'erreur visible dans le CRM
    await insertErrorRecord(booking.id, err.message, booking);

    return res.status(500).json({ error: err.message });
  }
}
