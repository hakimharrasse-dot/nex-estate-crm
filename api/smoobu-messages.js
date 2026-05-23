// ============================================================
// /api/smoobu-messages.js — Nex-Estate CRM
// Module messagerie IA : réception webhook Smoobu + envoi validé
//
// Endpoints :
//   POST (no query)    → webhook Smoobu action:newMessage
//                        → lit le message, génère analyse IA complète, INSERT messages
//   POST ?regenerate=1 → regénère le brouillon avec instruction Hakim
//                        → UPDATE ai_draft, ai_draft_fr, hakim_instruction
//   POST ?send=1       → envoie la réponse validée via Smoobu API
//                        → UPDATE statut='sent'
//   GET  ?probe=1      → health check
//
// Variables d'environnement requises :
//   SUPABASE_URL              → https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY → clé service_role (bypass RLS)
//   SMOOBU_API_KEY            → clé API Smoobu
//   ANTHROPIC_API_KEY         → clé Claude API (analyse + brouillon IA)
//
// Configurer dans Smoobu :
//   Settings → Advanced → API Keys → Webhook URLs
//   Ajouter : https://nex-estate-seven.vercel.app/api/smoobu-messages
//   NE PAS remplacer le webhook existant — Smoobu accepte plusieurs URLs
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMOOBU_KEY   = process.env.SMOOBU_API_KEY;
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY;
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

// ── Claude API : analyse complète en un seul appel ────────────
// Retourne : { detected_language, client_summary_fr, classification, ai_draft, ai_draft_fr }
async function generateFullAnalysis(ctx) {
  const { appart, voyageur, checkin, checkout, source, message_content, hakim_instruction } = ctx;

  const systemPrompt =
    'Tu es l\'assistant de Hakim, hôte de locations courte durée à Rabat et Salé (Maroc), société Nex-Estate.\n\n' +
    'Analyse le message du voyageur et réponds UNIQUEMENT avec un objet JSON valide sur une seule ligne (sans markdown, sans ``` , sans explication, juste le JSON brut).\n\n' +
    'Format exact :\n' +
    '{"detected_language":"code ISO 2 lettres","client_summary_fr":"résumé bref en français (1-2 phrases max, ce que dit le client)","classification":"simple","ai_draft":"réponse dans la langue du voyageur","ai_draft_fr":"traduction française fidèle de ai_draft"}\n\n' +
    'Règles pour ai_draft :\n' +
    '- Langue : celle du voyageur (déterminée par detected_language)\n' +
    '- Ton : court, humain, professionnel, sans emojis\n' +
    '- Ne jamais inventer d\'information\n' +
    '- Si info manquante ou incertaine : écrire "je vérifie et reviens vers vous"\n' +
    '- Ne jamais confirmer définitivement sans vérification côté hôte\n\n' +
    'Règles pour classification :\n' +
    '- "simple" : demande standard, question, information\n' +
    '- "sensible" : invités non déclarés, couple non marié, avis négatif, plainte légère, demande inhabituelle\n' +
    '- "conflit" : situation clairement conflictuelle, menace, litige\n' +
    '- "remboursement" : demande de remboursement ou annulation\n\n' +
    'Règles pour ai_draft_fr :\n' +
    '- Traduction fidèle de ai_draft en français\n' +
    '- Usage Hakim uniquement — ne jamais envoyer au voyageur';

  const instrNote = hakim_instruction
    ? `\n\nInstruction de Hakim pour cette réponse : ${hakim_instruction}`
    : '';

  const userPrompt =
    `Logement : ${appart    || 'non précisé'}\n` +
    `Voyageur : ${voyageur  || 'non précisé'}\n` +
    `Check-in : ${checkin   || 'non précisé'}\n` +
    `Check-out : ${checkout || 'non précisé'}\n` +
    `Plateforme : ${source  || 'non précisé'}\n\n` +
    `Message du voyageur :\n${message_content}` +
    instrNote;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API: ${res.status} ${err}`);
  }

  const data = await res.json();
  const rawText = (data.content?.[0]?.text || '').trim();

  // Nettoyer d'éventuels blocs markdown que Claude pourrait ajouter
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    const allowed = ['simple', 'sensible', 'conflit', 'remboursement'];
    return {
      detected_language: String(parsed.detected_language || '').slice(0, 10).trim() || null,
      client_summary_fr: String(parsed.client_summary_fr || '').trim()              || null,
      classification:    allowed.includes(parsed.classification) ? parsed.classification : 'simple',
      ai_draft:          String(parsed.ai_draft   || '').trim()                     || null,
      ai_draft_fr:       String(parsed.ai_draft_fr || '').trim()                    || null,
    };
  } catch (parseErr) {
    // Fallback si JSON invalide : retourner le texte brut comme ai_draft uniquement
    console.warn('[messages] Claude JSON parse failed:', parseErr.message, '| raw:', cleaned.slice(0, 200));
    return {
      detected_language: null,
      client_summary_fr: null,
      classification:    'simple',
      ai_draft:          rawText || null,
      ai_draft_fr:       null,
    };
  }
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
async function checkDuplicate(smoobuBookingId, messageContent, smoobuMessageId) {
  try {
    if (smoobuMessageId) {
      const rows = await sbGet(
        `messages?smoobu_message_id=eq.${encodeURIComponent(smoobuMessageId)}&select=id&limit=1`
      );
      return (rows?.length || 0) > 0;
    }
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
    return false;
  }
}

// ── Extraire le texte brut d'un message Smoobu ───────────────
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
function isGuestMessage(msg) {
  if (typeof msg.type === 'number') {
    return msg.type === 1;
  }
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
    return res.status(200).json({ ok: true, service: 'smoobu-messages', version: '2.0' });
  }

  // ── Sync threads : GET ?sync=1 ────────────────────────────
  // Appel périodique (cron Vercel) ou manuel.
  // Récupère les threads Smoobu récents et insère dans `messages`
  // les messages voyageurs non encore capturés (filet de sécurité webhook).
  // Paramètre optionnel : ?hours=N (défaut 24) — fenêtre de recherche.
  if (req.method === 'GET' && req.query?.sync) {
    if (!SMOOBU_KEY) return res.status(503).json({ error: 'SMOOBU_API_KEY manquante' });
    try {
      const hoursBack = Math.min(parseInt(req.query.hours || '24', 10) || 24, 72);
      const since = new Date(Date.now() - hoursBack * 3600 * 1000);
      console.log('[sync] démarrage — fenêtre:', hoursBack, 'h | since:', since.toISOString());

      // ── 1. Collecter les threads récents (pagination) ─────
      const recentThreads = [];
      let page = 1;
      let done = false;

      while (!done) {
        const r = await fetch(`${SMOOBU_API}/threads?page_number=${page}&page_size=20`, {
          headers: { 'Api-Key': SMOOBU_KEY, 'Content-Type': 'application/json' },
        });
        if (!r.ok) break;
        const data = await r.json();
        const threads = data.threads || [];
        if (!threads.length) break;

        for (const t of threads) {
          const msgAt = t.latest_message?.created_at ? new Date(t.latest_message.created_at) : null;
          // Les threads sont triés par latest_message DESC — dès qu'on tombe sous le seuil, stop
          if (msgAt && msgAt < since) { done = true; break; }
          if (t.booking?.id) recentThreads.push(t);
        }
        if (page >= (data.page_count || 1)) break;
        page++;
      }

      console.log('[sync] threads récents:', recentThreads.length);

      // ── 2. Traiter chaque thread (cap 10 AI/run) ──────────
      let processed = 0, skipped = 0, errors = 0, aiUsed = 0;
      const MAX_AI_PER_SYNC = 10; // cap sécurité : 10 appels Claude max par run (~30s)

      for (const thread of recentThreads) {
        const bookingId  = thread.booking.id;
        const guestName  = thread.booking.guest_name || '';
        const appart     = thread.apartment?.name    || '';

        try {
          // Lire les messages complets de la réservation
          const msgData = await getSmoobuMessages(bookingId);
          const allMessages = msgData?.messages || msgData?.data || (Array.isArray(msgData) ? msgData : []);

          const guestMessages = allMessages.filter(function(m) {
            return isGuestMessage(m) && extractMessageText(m).length > 0;
          });
          const lastMsg = guestMessages[guestMessages.length - 1];
          if (!lastMsg) { skipped++; continue; }

          const messageContent  = extractMessageText(lastMsg);
          const smoobuMessageId = extractSmoobuMessageId(lastMsg);

          // Déduplication — évite d'insérer un message déjà traité par le webhook
          const isDup = await checkDuplicate(bookingId, messageContent, smoobuMessageId);
          if (isDup) { skipped++; continue; }

          // Enrichir depuis resa CRM
          const resaCtx = await getResaContext(bookingId);

          // Analyse IA complète (limitée à MAX_AI_PER_SYNC appels/run)
          let analysis = { detected_language: null, client_summary_fr: null, classification: null, ai_draft: null, ai_draft_fr: null };
          if (CLAUDE_KEY && aiUsed < MAX_AI_PER_SYNC) {
            try {
              analysis = await generateFullAnalysis({
                appart:          resaCtx.appart   || appart,
                voyageur:        resaCtx.voyageur || guestName,
                checkin:         resaCtx.checkin  || '',
                checkout:        resaCtx.checkout || '',
                source:          resaCtx.source   || '',
                message_content: messageContent,
              });
              aiUsed++;
            } catch (claudeErr) {
              console.error('[sync] Claude error booking', bookingId, ':', claudeErr.message);
              analysis.ai_draft = '— Génération IA échouée — cliquez Regénérer pour réessayer. —';
            }
          } else if (aiUsed >= MAX_AI_PER_SYNC) {
            console.log('[sync] cap IA atteint — booking', bookingId, 'inséré sans brouillon (sera traité au prochain run)');
          }

          // Insérer dans messages
          const now = new Date().toISOString();
          await sbInsert('messages', {
            id:                uid(),
            smoobu_booking_id: bookingId,
            reservation_id:    resaCtx.id                 || null,
            appart:            resaCtx.appart   || appart || null,
            voyageur:          resaCtx.voyageur || guestName || null,
            source:            resaCtx.source               || null,
            sender:            'guest',
            message_content:   messageContent,
            detected_language: analysis.detected_language   || null,
            client_summary_fr: analysis.client_summary_fr   || null,
            classification:    analysis.classification       || null,
            ai_draft:          analysis.ai_draft             || null,
            ai_draft_fr:       analysis.ai_draft_fr          || null,
            smoobu_message_id: smoobuMessageId               || null,
            raw_payload:       { booking_id: bookingId, thread },
            statut:            'pending',
            created_at:        now,
            updated_at:        now,
          });

          console.log('[sync] INSERT OK — booking:', bookingId, '| voyageur:', guestName, '| lang:', analysis.detected_language);
          processed++;

        } catch (threadErr) {
          // Doublon DB (UNIQUE smoobu_message_id) → pas une vraie erreur
          if (threadErr.message.includes('23505') || threadErr.message.toLowerCase().includes('unique')) {
            skipped++;
          } else {
            console.error('[sync] erreur booking', bookingId, ':', threadErr.message);
            errors++;
          }
        }
      }

      console.log('[sync] terminé — processed:', processed, '| skipped:', skipped, '| errors:', errors, '| ai_calls:', aiUsed);
      return res.status(200).json({ ok: true, sync: true, hoursBack, threads_checked: recentThreads.length, processed, skipped, errors, ai_calls: aiUsed });

    } catch (syncErr) {
      console.error('[sync] erreur globale:', syncErr.message);
      return res.status(500).json({ error: syncErr.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !SMOOBU_KEY) {
    console.error('[messages] Variables d\'environnement manquantes');
    return res.status(500).json({ error: 'Variables d\'environnement manquantes' });
  }

  // ── Mode regénération : POST ?regenerate=1 ─────────────────
  // Appelé par le frontend quand Hakim saisit une instruction et clique "Regénérer".
  // Regénère uniquement ai_draft et ai_draft_fr — ne retouche pas l'entrée ni l'envoi.
  if (req.query?.regenerate) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { message_id, hakim_instruction } = body || {};

      if (!message_id || !String(message_id).trim()) {
        return res.status(400).json({ error: 'message_id requis' });
      }
      if (!hakim_instruction || !String(hakim_instruction).trim()) {
        return res.status(400).json({ error: 'hakim_instruction requis' });
      }
      if (!CLAUDE_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée' });
      }

      // Lire le message en base (contexte complet)
      const rows = await sbGet(
        `messages?id=eq.${encodeURIComponent(message_id)}&select=id,smoobu_booking_id,message_content,appart,voyageur,source,statut&limit=1`
      );
      const msg = rows?.[0];
      if (!msg) return res.status(404).json({ error: 'Message introuvable' });
      if (msg.statut === 'sent') return res.status(409).json({ error: 'Message déjà envoyé — impossible de regénérer' });

      // Récupérer checkin/checkout depuis resa via smoobu_booking_id
      const resaCtx = await getResaContext(msg.smoobu_booking_id);

      const analysis = await generateFullAnalysis({
        appart:            msg.appart   || resaCtx.appart   || '',
        voyageur:          msg.voyageur || resaCtx.voyageur || '',
        checkin:           resaCtx.checkin  || '',
        checkout:          resaCtx.checkout || '',
        source:            msg.source   || resaCtx.source   || '',
        message_content:   msg.message_content,
        hakim_instruction: String(hakim_instruction).trim(),
      });

      const now = new Date().toISOString();
      await sbPatch('messages', `id=eq.${encodeURIComponent(message_id)}`, {
        ai_draft:          analysis.ai_draft    || null,
        ai_draft_fr:       analysis.ai_draft_fr || null,
        hakim_instruction: String(hakim_instruction).trim(),
        updated_at:        now,
      });

      console.log('[messages] regenerate OK — message_id:', message_id, '| instruction:', String(hakim_instruction).slice(0, 60));
      return res.status(200).json({
        ok:         true,
        ai_draft:   analysis.ai_draft    || '',
        ai_draft_fr: analysis.ai_draft_fr || '',
      });

    } catch (err) {
      console.error('[messages] regenerate error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Mode envoi : POST ?send=1 ─────────────────────────────
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

      const rows = await sbGet(
        `messages?id=eq.${encodeURIComponent(message_id)}&select=id,smoobu_booking_id,statut&limit=1`
      );
      const msg = rows?.[0];
      if (!msg) return res.status(404).json({ error: 'Message introuvable en base' });
      if (msg.statut === 'sent')    return res.status(409).json({ error: 'Message déjà envoyé — doublon bloqué' });
      if (msg.statut === 'ignored') return res.status(409).json({ error: 'Message ignoré — impossible d\'envoyer' });

      await sendSmoobuMessage(msg.smoobu_booking_id, String(text).trim());

      const now = new Date().toISOString();
      await sbPatch('messages', `id=eq.${encodeURIComponent(message_id)}`, {
        statut:     'sent',
        ai_draft:   String(text).trim(),
        sent_at:    now,
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

  if (action !== 'newMessage') {
    return res.status(200).json({ ok: true, skipped: `action ignorée: ${action}` });
  }

  if (!booking?.id) {
    return res.status(400).json({ error: 'booking.id manquant dans le payload Smoobu' });
  }

  try {
    // 1. Lire les messages complets de la réservation via Smoobu
    const msgData = await getSmoobuMessages(booking.id);
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

    const messageContent  = extractMessageText(lastMsg);
    const smoobuMessageId = extractSmoobuMessageId(lastMsg);

    if (!messageContent) {
      return res.status(200).json({ ok: true, skipped: 'empty_message' });
    }

    // 2. Déduplication
    const isDup = await checkDuplicate(booking.id, messageContent, smoobuMessageId);
    if (isDup) {
      console.log('[messages] Doublon détecté — booking:', booking.id, '| skipped');
      return res.status(200).json({ ok: true, skipped: 'duplicate' });
    }

    // 3. Enrichir depuis la table resa
    const resaCtx = await getResaContext(booking.id);
    const guestName = resaCtx.voyageur ||
      [booking.guest?.firstname, booking.guest?.lastname].filter(Boolean).join(' ') ||
      booking.guestName || '';
    const appart  = resaCtx.appart   || booking.apartment?.name || '';
    const source  = resaCtx.source   || '';
    const checkin = resaCtx.checkin  || booking.arrivalDate   || '';
    const checkout = resaCtx.checkout || booking.departureDate || '';

    // 4. Analyse IA complète via Claude (résumé FR + brouillon + traduction + classification)
    let analysis = { detected_language: null, client_summary_fr: null, classification: null, ai_draft: null, ai_draft_fr: null };
    if (CLAUDE_KEY) {
      try {
        analysis = await generateFullAnalysis({
          appart, voyageur: guestName, checkin, checkout, source,
          message_content: messageContent,
        });
        console.log('[messages] Claude OK — lang:', analysis.detected_language, '| classif:', analysis.classification);
      } catch (claudeErr) {
        console.error('[messages] Claude error:', claudeErr.message);
        analysis.ai_draft = '— Génération automatique échouée. Rédigez votre réponse ci-dessous. —';
      }
    } else {
      console.warn('[messages] ANTHROPIC_API_KEY non configurée — analyse IA ignorée');
    }

    // 5. INSERT dans la table messages
    const now = new Date().toISOString();
    const newMsg = {
      id:                uid(),
      smoobu_booking_id: booking.id,
      reservation_id:    resaCtx.id          || null,
      appart:            appart              || null,
      voyageur:          guestName           || null,
      source:            source              || null,
      sender:            'guest',
      message_content:   messageContent,
      detected_language: analysis.detected_language || null,
      client_summary_fr: analysis.client_summary_fr || null,
      classification:    analysis.classification    || null,
      ai_draft:          analysis.ai_draft          || null,
      ai_draft_fr:       analysis.ai_draft_fr       || null,
      smoobu_message_id: smoobuMessageId     || null,
      raw_payload:       booking             || null,
      statut:            'pending',
      created_at:        now,
      updated_at:        now,
    };

    await sbInsert('messages', newMsg);
    console.log('[messages] INSERT OK — booking:', booking.id, '| appart:', appart, '| voyageur:', guestName, '| lang:', analysis.detected_language, '| resa_id:', resaCtx.id || 'non liée');

    return res.status(200).json({ ok: true, action, message_id: newMsg.id });

  } catch (err) {
    const isDupViolation = err.message.includes('23505') || err.message.toLowerCase().includes('unique');
    if (isDupViolation) {
      console.log('[messages] Doublon DB (UNIQUE constraint) — booking:', booking.id);
      return res.status(200).json({ ok: true, skipped: 'duplicate_db' });
    }

    console.error('[messages] erreur traitement:', err.message, err);
    await insertErrorRecord(booking.id, err.message, booking);
    return res.status(500).json({ error: err.message });
  }
}
