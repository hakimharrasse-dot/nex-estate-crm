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

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMOOBU_KEY   = process.env.SMOOBU_API_KEY;
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY;
const SMOOBU_API   = 'https://login.smoobu.com/api';

// ── Smoobu HMAC-SHA256 (obligatoire à partir du 25/09/2026) ───────────────
// La signature s'ACTIVE automatiquement dès que SMOOBU_API_SECRET est présent
// dans l'environnement. Sans secret → mode "legacy" (clé seule, non signé),
// identique à aujourd'hui et accepté pendant la migration → déploiement sûr.
// Format vérifié le 2026-07-02 contre l'API réelle (login.smoobu.com) :
//   canonical = METHOD\nPATH\nQUERY(trié+URL-encodé)\nTIMESTAMP\nNONCE\nSHA256hex(body)\nAPIKEY
//   X-Signature = base64( HMAC-SHA256(canonical, SECRET) )   ; body vide = SHA256("")
// ⚠️ Bloc IDENTIQUE dans api/smoobu-poll.js — garder les deux synchronisés.
const SMOOBU_HOST   = 'https://login.smoobu.com';
const SMOOBU_SECRET = process.env.SMOOBU_API_SECRET || '';
const EMPTY_SHA256  = crypto.createHash('sha256').update('').digest('hex');

function _smoobuQuery(query) {
  if (!query) return '';
  const keys = Object.keys(query).filter((k) => query[k] !== undefined && query[k] !== null);
  if (!keys.length) return '';
  keys.sort();
  return keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
}

// path commence par /api ; query = objet {clé:valeur} ; body = objet JSON ou null.
async function smoobuFetch(path, { method = 'GET', query = null, body = null, apiKey } = {}) {
  const key = apiKey || process.env.SMOOBU_API_KEY;
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
// ⚠️ DEUX pièges Smoobu, tous deux gérés ici :
// 1) onlyRelatedToGuest=false est INDISPENSABLE : sans lui, l'API ne renvoie QUE le
//    voyageur (type=1) — les réponses hôte (type=2, tapées dans Airbnb/Booking/Smoobu
//    ou envoyées via le CRM) sont invisibles.
// 2) L'endpoint est PAGINÉ : page_size FIXE à 25 (pageSize/limit ignorés) ; la page 1
//    = les 25 messages les plus ANCIENS. Sans parcourir toutes les pages, les
//    conversations > 25 messages sont tronquées et les messages RÉCENTS manquent
//    (vérifié 2026-07-03 : booking 145626671 Nancy = 61 msgs sur 3 pages ; page 1 seule
//    → on ne voyait que le début). On récupère donc TOUTES les pages via ?page=N.
// isGuestMessage() distingue déjà type 1/2 ; sortMessagesChronologically() trie ensuite.
async function getSmoobuMessages(bookingId) {
  const MAX_PAGES = 20; // garde-fou : 20 × 25 = 500 messages max
  let all = [];
  let pageCount = 1;
  for (let page = 1; page <= pageCount && page <= MAX_PAGES; page++) {
    const res = await smoobuFetch(`/api/reservations/${bookingId}/messages`, {
      query: { onlyRelatedToGuest: 'false', page },
    });
    // 404 = booking inconnu de l'endpoint messages = prospect / inquiry (Smoobu n'expose
    // PAS les conversations sans réservation). Pas une erreur traitable : on retourne
    // vide → le handler ignore proprement (aucun faux record « erreur »).
    if (res.status === 404) {
      console.log('[messages] 404 messages (prospect/inquiry, non exposé par Smoobu) — booking:', bookingId, '| skip');
      return { messages: [] };
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Smoobu GET messages [${bookingId}] p${page}: ${res.status} ${err}`);
    }
    const data = await res.json();
    const msgs = data?.messages || data?.data || (Array.isArray(data) ? data : []);
    all = all.concat(msgs);
    pageCount = Number(data?.page_count) || 1;
  }
  return { messages: all };
}

// ── Smoobu : envoyer un message au voyageur ───────────────────
// Retourne { httpStatus, body, rawText, confirmed }
// confirmed = true si Smoobu a retourné un objet avec id (preuve de création)
// Endpoint officiel Smoobu (doc v2) :
//   POST /api/reservations/{id}/messages/send-message-to-guest
//   Body : { messageBody: "...", subject: "..." (optionnel) }
async function sendSmoobuMessage(bookingId, text) {
  const res = await smoobuFetch(`/api/reservations/${bookingId}/messages/send-message-to-guest`, {
    method: 'POST',
    body:   { messageBody: text },
  });
  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Smoobu POST message [${bookingId}]: ${res.status} ${rawText}`);
  }
  let body;
  try { body = JSON.parse(rawText); } catch { body = { raw: rawText }; }
  const msgId = body?.id ?? body?.data?.id ?? null;
  // On est passé le guard !res.ok → réponse 2xx (Smoobu renvoie souvent 201
  // "Resource created successfully" SANS id) = message bel et bien envoyé.
  // Ne PAS exiger un id, sinon des envois réussis étaient marqués "échec".
  const confirmed = true;
  return { httpStatus: res.status, body, rawText, confirmed, msgId };
}

// Extrait le PRÉNOM du voyageur pour personnaliser la salutation ('' si inconnu).
function guestFirstName(name) {
  const n = String(name || '').trim();
  if (!n || /sans nom|inconnu|unknown|guest|voyageur|n\/a/i.test(n)) return '';
  const first = n.split(/[\s,]+/)[0] || '';
  return first.length >= 2 ? first : '';
}

// ── Claude API : analyse complète en un seul appel ────────────
// Retourne : { detected_language, client_summary_fr, classification, ai_draft, ai_draft_fr }
async function generateFullAnalysis(ctx) {
  const { appart, voyageur, checkin, checkout, source, message_content, conversation, hakim_instruction,
          reservation_confirmed, days_until_checkin_ctx, style_examples, apartment_kb, adults, children } = ctx;
  const phase = stayPhase(checkin, checkout);
  const firstName = guestFirstName(voyageur);

  const systemPrompt =
    'Tu es l\'assistant de Hakim, hôte de locations courte durée à Rabat et Salé (Maroc), société Nex-Estate.\n\n' +
    'Analyse le message du voyageur et réponds UNIQUEMENT avec un objet JSON valide sur une seule ligne (sans markdown, sans ``` , sans explication, juste le JSON brut). ' +
    'IMPÉRATIF : même si l\'instruction de Hakim est formulée comme une question ou une conversation (« est-ce que tu as… », « peux-tu… »), tu ne réponds JAMAIS de façon conversationnelle et tu n\'ajoutes AUCUNE note, AUCUN commentaire, AUCUN texte avant ou après le JSON. Ta réponse entière = le seul objet JSON.\n\n' +
    'Format exact :\n' +
    '{"detected_language":"code ISO 2 lettres","client_summary_fr":"résumé bref en français (1-2 phrases max, ce que dit le client)","classification":"simple","ai_draft":"réponse dans la langue du voyageur","ai_draft_fr":"traduction française fidèle de ai_draft"}\n\n' +
    'Règles pour ai_draft :\n' +
    (firstName
      ? '- ⚡⚡ RÈGLE ABSOLUE N°1 : COMMENCE TOUJOURS par une salutation contenant le PRÉNOM « ' + firstName + ' » — « Bonjour ' + firstName + ', » / « Salam ' + firstName + ', » / « Hello ' + firstName + ', » selon la langue du voyageur. Cette règle PRIME sur les exemples de style : même si les anciennes réponses ci-dessous ne mettent pas de prénom, TOI tu mets TOUJOURS « ' + firstName + ' ». INTERDIT de commencer par « Bonjour » seul, « Salut », « Hi » ou « Hello » sans le prénom.\n'
      : '') +
    '- Langue : celle du voyageur (déterminée par detected_language)\n' +
    '- Ton : court, humain, professionnel, sans emojis\n' +
    '- Ne jamais inventer d\'information\n' +
    '- ⚡ Si l\'information demandée FIGURE dans les INFORMATIONS VÉRIFIÉES DE CE LOGEMENT ou le PLAYBOOK ci-dessous (ex : piscine, climatisation, parking, wifi, équipements, règles), RÉPONDS-LA DIRECTEMENT. Ne dis JAMAIS « je vérifie » ni « je reviens vers vous » pour une info qui est déjà fournie ci-dessous — même si le voyageur demande « est-ce toujours d\'actualité ? » (les infos fournies font foi).\n' +
    '- N\'écris « je vérifie et reviens vers vous » QUE si l\'information est réellement absente du contexte ci-dessous.\n' +
    '- Ne jamais confirmer définitivement sans vérification côté hôte\n\n' +
    'Règles pour classification :\n' +
    '- "no_reply_needed" : message trivial sans action requise (merci, ok, bien reçu, emoji, confirmation sans question, j\'ai trouvé, à bientôt, bonne nuit, de rien, you\'re welcome) → ai_draft et ai_draft_fr doivent être des chaînes vides ""\n' +
    '- "simple" : demande standard, question, information\n' +
    '- "sensible" : invités non déclarés, couple non marié, avis négatif, plainte légère, demande inhabituelle\n' +
    '- "conflit" : situation clairement conflictuelle, menace, litige\n' +
    '- "remboursement" : demande de remboursement ou annulation\n\n' +
    'Règles contextuelles supplémentaires :\n' +
    '- Si "Réservation confirmée = Oui" → ne jamais écrire "après confirmation de votre réservation" — la réservation EST déjà confirmée\n' +
    '- Ne jamais inventer un code, une adresse ou un horaire absent du contexte.\n\n' +
    'TRÈS IMPORTANT — adapte ta réponse à la PHASE DU SÉJOUR (fournie dans le contexte) :\n' +
    '- AVANT l\'arrivée / arrive demain / arrive aujourd\'hui : tu peux dire que les détails d\'accès et le code de la serrure seront envoyés le jour de l\'arrivée (après vérification des pièces d\'identité). Ne promets pas un envoi "24h avant".\n' +
    '- SÉJOUR EN COURS (déjà sur place) ou DÉPART : le voyageur est DÉJÀ dans le logement et possède DÉJÀ ses accès et son code → ne dis JAMAIS qu\'il "recevra" le code, le wifi ou les instructions d\'arrivée. Réponds directement à sa demande réelle du moment (problème, info pratique, prolongation, départ…). S\'il redemande le wifi, redonne-le simplement.\n' +
    '- Séjour TERMINÉ : le voyageur est reparti — réponds en conséquence (avis, objet oublié, facture…).\n' +
    '- Tiens compte de la COMPOSITION (adultes / enfants) quand c\'est pertinent (serviettes, capacité, accès piscine réservé aux moins de 14 ans, etc.).\n\n' +
    'Règles pour ai_draft_fr :\n' +
    '- Traduction fidèle de ai_draft en français\n' +
    '- Usage Hakim uniquement — ne jamais envoyer au voyageur\n\n' +
    'INSTRUCTION DE HAKIM (si fournie) — applique-la de façon ADDITIVE et CHIRURGICALE :\n' +
    '- Si Hakim demande plusieurs choses (ex : « envoie le lien ET dis-lui qu\'il a déjà reçu un guide »), inclus TOUTES ses demandes — n\'en omets aucune.\n' +
    '- Une demande d\'AJOUT (« ajoute… », « dis aussi… », « en plus… ») ne REMPLACE jamais le reste : garde le contenu utile de ta réponse (liens, infos, coordonnées) ET ajoute ce qu\'il demande.\n' +
    '- N\'enlève une information (ex : un lien) QUE si Hakim te le demande explicitement. Ne « développe » pas au point de supprimer ce qu\'il voulait envoyer.\n' +
    '- IMPÉRATIF : si une instruction de Hakim est fournie dans le message ci-dessous, tu DOIS rédiger ai_draft et ai_draft_fr en appliquant cette instruction. Dans ce cas la classification ne peut JAMAIS être "no_reply_needed" (Hakim te demande explicitement d\'écrire un message au voyageur) — produis toujours un brouillon, même si le dernier message du voyageur était un simple « merci » ou « ok ».' +
    globalPlaybook() +
    hakimStyleGuide() +
    styleBlock(style_examples);

  const instrNote = hakim_instruction
    ? `\n\nInstruction de Hakim pour cette réponse (à appliquer de façon additive — inclure TOUTES ses demandes sans supprimer le reste) : ${hakim_instruction}`
    : '';

  const resaLine   = `Réservation confirmée : ${reservation_confirmed === true ? 'Oui' : reservation_confirmed === false ? 'Non' : 'non précisé'}\n`;
  const phaseLine  = `PHASE DU SÉJOUR (aujourd'hui = ${new Date().toISOString().slice(0,10)}) : ${phase.label}\n`;
  const compoLine  = (adults != null || children != null)
    ? `Composition : ${adults != null ? adults : '?'} adulte(s)${children ? ', ' + children + ' enfant(s)' : (children === 0 ? ', 0 enfant' : '')}\n`
    : '';

  // On fournit le fil récent comme CONTEXTE, mais l'IA ne doit répondre qu'au(x)
  // dernier(s) message(s) NON traité(s) — surtout pas aux anciens déjà répondus.
  const msgBlock = (conversation && conversation.trim() && conversation.trim() !== (message_content || '').trim())
    ? `\nFil de discussion récent (du plus ANCIEN au plus RÉCENT ; « Voyageur » = lui, « Hôte » = vos réponses DÉJÀ envoyées) :\n${conversation}\n\n` +
      '⚠️ IMPORTANT — l\'hôte (Hakim) répond très souvent DIRECTEMENT sur la plateforme (Airbnb/Booking/Smoobu), et ces réponses N\'APPARAISSENT PAS dans ce fil (seules ses réponses envoyées via le CRM y figurent en « Hôte »). En journée, l\'hôte répond presque TOUJOURS en moins d\'1 heure. ' +
      'CONCLUSION : tout message du voyageur qui n\'est pas dans le DERNIER groupe récent (les toutes dernières minutes / la dernière heure, en bas du fil) a TRÈS PROBABLEMENT DÉJÀ reçu une réponse de l\'hôte (invisible ici) → considère-le comme DÉJÀ TRAITÉ.\n' +
      '⚡⚡ RÈGLE ABSOLUE — réponds UNIQUEMENT au DERNIER groupe de messages récents du voyageur. ' +
      'Les messages plus ANCIENS (déjà suivis d\'une réponse « Hôte », OU séparés du dernier groupe par un écart de temps notable, OU datant de plusieurs heures/jours/semaines) sont du CONTEXTE uniquement : N\'Y RÉPONDS PAS, ne reviens pas dessus, SAUF si le dernier message y fait explicitement référence. ' +
      'CAS DE LA RAFALE : si le voyageur a envoyé PLUSIEURS messages d\'affilée RÉCEMMENT (rapprochés dans le temps — même jour/même heure — et SANS réponse « Hôte » entre eux), considère-les comme UN SEUL message et réponds à l\'ENSEMBLE de ce groupe en une seule réponse (c\'est une seule pensée découpée en plusieurs bulles). ' +
      '⚡⚡ COMPRÉHENSION DU CONTEXTE (CAPITAL) : avant de répondre, LIS et COMPRENDS la TOTALITÉ du fil — qui est ce client, ce qu\'il a déjà demandé, ce qui a déjà été réglé, les sujets encore en cours. Si le dernier message FAIT RÉFÉRENCE ou REVIENT à un sujet évoqué plus haut (même un point ancien, résolu ou non), ou contient une allusion implicite (« et pour l\'autre chose ? », « finalement ? », « comme je disais », « toujours d\'accord ? », « du coup ? »), tu DOIS relier ce message à ce sujet et répondre AVEC ce contexte — jamais « hors-sol » comme si c\'était une demande isolée. Réponds comme quelqu\'un qui a TOUT lu et suivi la conversation depuis le début, pas seulement la dernière ligne. ⚠️ Ceci ne contredit PAS la règle de récence : tu réponds toujours au DERNIER message du voyageur, mais en l\'ÉCLAIRANT de tout l\'historique (le récent = ce à quoi tu réponds ; l\'ancien = le contexte qui donne du sens). ' +
      'Si le dernier message du voyageur est juste un remerciement / une confirmation, classe "no_reply_needed".'
    : `\nMessage du voyageur (réponds à CE message) :\n${message_content}`;

  const salutLine = firstName
    ? `PRÉNOM DU VOYAGEUR (à utiliser OBLIGATOIREMENT dans la salutation) : ${firstName}\n`
    : `PRÉNOM DU VOYAGEUR : inconnu — salue poliment sans prénom (« Bonjour, »).\n`;

  const userPrompt =
    `Logement : ${appart    || 'non précisé'}\n` +
    `Voyageur : ${voyageur  || 'non précisé'}\n` +
    salutLine +
    `Check-in : ${checkin   || 'non précisé'}\n` +
    `Check-out : ${checkout || 'non précisé'}\n` +
    `Plateforme : ${source  || 'non précisé'}\n` +
    resaLine + phaseLine + compoLine +
    kbBlock(apartment_kb) +
    msgBlock +
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

  // Extraction ROBUSTE du JSON : Claude ajoute parfois une note/explication autour
  // (surtout quand l'instruction de Hakim est formulée comme une question). On tente
  // le parse direct, puis on isole le premier objet {...} présent dans la réponse.
  const parsed = extractJsonObject(rawText);
  if (parsed) {
    const allowed = ['no_reply_needed', 'simple', 'sensible', 'conflit', 'remboursement'];
    let classif = allowed.includes(parsed.classification) ? parsed.classification : 'simple';
    // Si Hakim a donné une consigne explicite, il veut un message : ne jamais étouffer le
    // brouillon sous "no_reply_needed" (sinon Régénérer avec consigne ne renvoie rien).
    if (hakim_instruction && classif === 'no_reply_needed') classif = 'simple';
    return {
      detected_language: String(parsed.detected_language || '').slice(0, 10).trim() || null,
      client_summary_fr: String(parsed.client_summary_fr || '').trim()              || null,
      classification:    classif,
      // Si no_reply_needed : pas de brouillon (Claude renvoie "" — on force null)
      ai_draft:    classif === 'no_reply_needed' ? null : (String(parsed.ai_draft   || '').trim() || null),
      ai_draft_fr: classif === 'no_reply_needed' ? null : (String(parsed.ai_draft_fr || '').trim() || null),
    };
  }
  // Échec total : ne JAMAIS renvoyer le JSON/texte brut dans le champ (anti-charabia).
  // Brouillon vide → l'UI invite à régénérer.
  console.warn('[messages] Claude JSON parse failed | raw:', rawText.slice(0, 300));
  return {
    detected_language: null,
    client_summary_fr: null,
    classification:    'simple',
    ai_draft:          null,
    ai_draft_fr:       null,
  };
}

// Isole et parse le premier objet JSON {...} d'une réponse Claude, même si du texte
// (note, markdown, explication) l'entoure. Renvoie l'objet ou null.
function extractJsonObject(rawText) {
  const txt = String(rawText || '');
  const cleaned = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const first = cleaned.indexOf('{');
  const last  = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (e) {}
  }
  return null;
}

// ── Claude Vision : analyse d'une IMAGE envoyée par un voyageur ────
// Décrit l'image en français + propose un brouillon de réponse. Retourne :
// { description_fr, detected_language, classification, ai_draft, ai_draft_fr }
async function analyzeImageMessage(ctx) {
  const { appart, source, message_content, hakim_instruction, image_base64, media_type,
          checkin, checkout, adults, children, style_examples, apartment_kb } = ctx;
  const phase = stayPhase(checkin, checkout);

  const systemPrompt =
    'Tu es l\'assistant de Hakim, hôte de locations courte durée à Rabat et Salé (Maroc), société Nex-Estate.\n\n' +
    'On te donne une IMAGE envoyée par un voyageur (parfois accompagnée d\'un texte). Analyse-la et réponds ' +
    'UNIQUEMENT avec un objet JSON valide sur une seule ligne (pas de markdown, pas de ```, aucun texte avant/après).\n' +
    'Format exact :\n' +
    '{"description_fr":"ce que montre l\'image, factuel et bref (1-2 phrases), + ce que le voyageur semble vouloir ou signaler","detected_language":"code ISO 2 lettres du texte visible dans l\'image, sinon fr","classification":"simple","ai_draft":"brouillon de réponse dans la langue du voyageur","ai_draft_fr":"traduction française de ai_draft"}\n\n' +
    'Règles :\n' +
    '- ⚡ DÉCRIS UNIQUEMENT CE QUI EST CLAIREMENT VISIBLE sur l\'image (objets, texte lisible, état). N\'INVENTE RIEN : pas de cause, pas de problème, pas de scénario qui ne se voit pas. Ex : un récipient posé quelque part = « un récipient » — n\'en déduis PAS une fuite ou une infiltration si rien ne le montre.\n' +
    '- ⚡ SI LE BUT DE LA PHOTO EST AMBIGU (on ne sait pas ce que le voyageur veut), dis-le clairement dans description_fr (« la raison de cette photo n\'est pas claire »), et fais un ai_draft qui DEMANDE poliment au voyageur ce qu\'il souhaite signaler — ne suppose pas un problème.\n' +
    '- Si l\'image contient du texte (capture d\'écran, message), transcris/résume ce texte fidèlement.\n' +
    '- CONFIDENTIALITÉ : si c\'est une pièce d\'identité ou un document officiel, ne retranscris JAMAIS les numéros (CIN, passeport, carte) ni les données sensibles — indique seulement que le document a bien été reçu.\n' +
    '- Classification : "no_reply_needed" si aucune réponse utile (ai_draft et ai_draft_fr = ""), sinon "simple" / "sensible" / "conflit" / "remboursement".\n' +
    '- Si une instruction de Hakim est fournie, applique-la et NE classe jamais "no_reply_needed" (produis un brouillon).\n' +
    '- Ne jamais inventer une information (code, adresse, horaire, montant) absente du contexte.' +
    globalPlaybook() + hakimStyleGuide() + styleBlock(style_examples);

  const userText =
    `Logement : ${appart || 'non précisé'}\n` +
    `Plateforme : ${source || 'non précisé'}\n` +
    `PHASE DU SÉJOUR (aujourd'hui = ${new Date().toISOString().slice(0,10)}) : ${phase.label}\n` +
    ((adults != null || children != null) ? `Composition : ${adults != null ? adults : '?'} adulte(s)${children ? ', ' + children + ' enfant(s)' : ''}\n` : '') +
    kbBlock(apartment_kb) +
    (message_content ? `\nTexte envoyé avec la photo (voyageur) :\n${message_content}\n` : '') +
    (hakim_instruction ? `\nInstruction de Hakim (à appliquer) : ${hakim_instruction}\n` : '') +
    '\nDécris l\'image ci-jointe et propose une réponse si pertinent.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  1024,
      temperature: 0,                 // description ancrée aux faits (moins d'invention)
      system:      systemPrompt,
      messages:    [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: media_type, data: image_base64 } },
        { type: 'text',  text: userText },
      ] }],
    }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Claude API (image): ${res.status} ${err}`); }

  const data = await res.json();
  const rawText = (data.content?.[0]?.text || '').trim();
  const parsed = extractJsonObject(rawText);
  if (parsed) {
    const allowed = ['no_reply_needed', 'simple', 'sensible', 'conflit', 'remboursement'];
    let classif = allowed.includes(parsed.classification) ? parsed.classification : 'simple';
    if (hakim_instruction && classif === 'no_reply_needed') classif = 'simple';
    return {
      description_fr:    String(parsed.description_fr || '').trim() || null,
      detected_language: String(parsed.detected_language || '').slice(0, 10).trim() || null,
      classification:    classif,
      ai_draft:    classif === 'no_reply_needed' ? null : (String(parsed.ai_draft    || '').trim() || null),
      ai_draft_fr: classif === 'no_reply_needed' ? null : (String(parsed.ai_draft_fr || '').trim() || null),
    };
  }
  // Échec parse JSON : au moins renvoyer le texte comme description (jamais de charabia structuré).
  return { description_fr: rawText.slice(0, 500) || null, detected_language: null, classification: 'simple', ai_draft: null, ai_draft_fr: null };
}

// ── Reformuler un brouillon de Hakim (orthographe + ton pro) ──
// Prend le texte écrit par l'hôte et le polit SANS changer le sens ni inventer.
async function rewordReply(text, ctx) {
  const c = ctx || {};
  const systemPrompt =
    'Tu es l\'assistant de Hakim, hôte de locations courte durée à Rabat et Salé (Nex-Estate). ' +
    'On te donne un brouillon de réponse que HAKIM (l\'hôte) veut envoyer à un voyageur. ' +
    'Reformule-le pour qu\'il soit professionnel, poli, clair et naturel : corrige l\'orthographe et la grammaire, améliore la formulation.\n\n' +
    'RÈGLES STRICTES :\n' +
    '- Garde EXACTEMENT le même sens et la même intention que le brouillon\n' +
    '- N\'ajoute AUCUNE information nouvelle (jamais de code, adresse, horaire, prix ou promesse inventés)\n' +
    '- Réponds dans la MÊME langue que le brouillon\n' +
    '- Ton humain et professionnel, sans emojis\n' +
    '- Renvoie UNIQUEMENT le texte reformulé, rien d\'autre (pas de guillemets, pas d\'explication, pas de préfixe)' +
    styleBlock(c.styleExamples);
  const userPrompt =
    ((c.appart || c.source)
      ? `Contexte (pour le ton uniquement, ne rien inventer) : logement ${c.appart || '—'}, plateforme ${c.source || '—'}.\n\n`
      : '') +
    `Brouillon de Hakim à reformuler :\n${text}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Claude API (reword): ${res.status} ${err}`); }
  const data = await res.json();
  const out = (data.content?.[0]?.text || '').trim()
    .replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```\s*$/, '')
    .replace(/^["«»\s]+|["«»\s]+$/g, '')
    .trim();
  return out || text;
}

// ── Style de Hakim : ses dernières réponses ENVOYÉES (few-shot) ──
// Sert à faire imiter son ton par l'IA. Lecture seule, best-effort.
async function getHakimStyleExamples(limit) {
  try {
    const rows = await sbGet(
      `messages?statut=eq.sent&ai_draft=not.is.null&select=ai_draft,sent_at&order=sent_at.desc.nullslast&limit=${limit || 6}`
    );
    return (rows || [])
      .map(function(r){ return String(r.ai_draft || '').trim(); })
      .filter(function(s){ return s && s.length >= 10 && s.length <= 600; })
      .slice(0, limit || 6);
  } catch { return []; }
}
function styleBlock(examples) {
  if (!examples || !examples.length) return '';
  return '\n\nSTYLE DE HAKIM — n\'imite QUE le vocabulaire et le ton de ces exemples, PAS leur longueur ni leurs formules de politesse : la règle de brièveté (1 à 3 phrases, pas de bienvenue émotionnelle, pas de clôture non demandée) PRIME sur ces exemples, même s\'ils sont plus longs ou plus chaleureux. ⚠️ N\'imite PAS non plus l\'ABSENCE de prénom : ces exemples commencent souvent par « Bonjour » seul, mais TOI tu DOIS toujours mettre le prénom du voyageur dans la salutation (voir Règle ABSOLUE N°1). Ne recopie jamais mot pour mot :\n' +
    examples.map(function(s, i){ return '— ' + s; }).join('\n');
}

// ── Assistant : affiner un brouillon (refine) ou conseiller (advise) ──
async function assistReply(mode, p) {
  const phase = stayPhase(p.checkin, p.checkout);
  const phaseLine = (p.checkin || p.checkout)
    ? `Phase du séjour (aujourd'hui = ${new Date().toISOString().slice(0,10)}) : ${phase.label}` +
      ((p.adults != null || p.children != null) ? ` · ${p.adults != null ? p.adults : '?'} adulte(s)${p.children ? ', ' + p.children + ' enfant(s)' : ''}` : '') + '\n'
    : '';
  const ctxLine = (p.clientContext && p.clientContext.trim())
    ? `Message(s) du voyageur :\n${p.clientContext.trim()}\n\n` + phaseLine + '\n'
    : phaseLine;
  let system, user;
  if (mode === 'advise') {
    system =
      'Tu es le relecteur de Hakim, hôte de locations courte durée à Rabat/Salé (Nex-Estate). ' +
      'On te donne le(s) message(s) du voyageur et le brouillon de réponse de HAKIM. ' +
      'Donne à Hakim un avis court et concret EN FRANÇAIS (3 à 5 puces maximum) : ce qui va, ce qui manque, ' +
      'les infos risquées ou non confirmées (code, horaire, prix, promesse), le ton à ajuster. ' +
      'Vérifie la COHÉRENCE avec la PHASE DU SÉJOUR (fournie) : signale par ex. si le brouillon dit au voyageur qu\'il "recevra" le code/les accès alors qu\'il est DÉJÀ sur place. ' +
      'NE RÉÉCRIS PAS la réponse — donne uniquement tes notes, en puces courtes commençant par "• ". ' +
      'Si le brouillon est déjà bon, dis-le franchement.';
    user = ctxLine + `Brouillon de Hakim :\n${p.draft}` + (p.instruction ? `\n\nPoint d'attention demandé par Hakim : ${p.instruction}` : '');
  } else { // refine
    system =
      'Tu es l\'assistant de Hakim, hôte de locations courte durée à Rabat/Salé (Nex-Estate). ' +
      'On te donne le(s) message(s) du voyageur, le brouillon actuel de Hakim et une consigne de Hakim. ' +
      'Révise le brouillon selon la consigne.\n\nRÈGLES STRICTES :\n' +
      '- Garde l\'intention de Hakim\n' +
      '- Applique la consigne de façon ADDITIVE et CHIRURGICALE : conserve tout le contenu déjà correct du brouillon (liens, infos, coordonnées, salutations) ; une demande d\'AJOUT n\'enlève rien d\'autre. N\'enlève une info (ex : un lien) QUE si Hakim le demande explicitement.\n' +
      '- N\'invente AUCUNE information (jamais de code, adresse, prix, horaire ou promesse inventés)\n' +
      '- Réponds dans la MÊME langue que le brouillon\n' +
      '- Ton humain et professionnel, sans emojis\n' +
      '- Respecte la PHASE DU SÉJOUR (fournie) : si le voyageur est DÉJÀ sur place, ne propose jamais de "lui envoyer" le code/le wifi/les accès (il les a déjà) ; s\'il arrive bientôt, le code de serrure est envoyé le jour de l\'arrivée\n' +
      '- Renvoie UNIQUEMENT le texte révisé, rien d\'autre (pas de guillemets, pas d\'explication)' +
      globalPlaybook() + hakimStyleGuide() + styleBlock(p.styleExamples) + kbBlock(p.apartmentKb);
    user = ctxLine + `Brouillon actuel :\n${p.draft}\n\nConsigne de Hakim : ${p.instruction || '(améliore-le, rends-le plus naturel et professionnel)'}`;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Claude API (assist ${mode}): ${res.status} ${err}`); }
  const data = await res.json();
  let out = (data.content?.[0]?.text || '').trim().replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (mode === 'refine') out = out.replace(/^["«»\s]+|["«»\s]+$/g, '').trim();
  return out;
}

// ── Traduction (messagerie style Airbnb) ─────────────────────
// claudeJSON : appel Claude renvoyant un JSON (helper interne).
async function _claudeText(system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens || 1024, system: system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Claude API (translate): ${res.status} ${err}`); }
  const data = await res.json();
  return (data.content?.[0]?.text || '').trim();
}
// Traduit un lot de messages vers le français + détecte la langue source dominante.
async function translateBatchToFrench(texts) {
  const arr = (texts || []).map(function(t){ return String(t || ''); });
  if (!arr.length) return { detected: 'fr', translations: [] };
  const system =
    'Tu traduis des messages de voyageurs vers le FRANÇAIS pour l\'hôte Hakim (locations courte durée). ' +
    'Traduis FIDÈLEMENT chaque message (garde le sens, le ton, les chiffres). Si un message est déjà en français, renvoie-le tel quel. ' +
    'Détecte aussi la langue source dominante. Réponds UNIQUEMENT avec un objet JSON valide sur une seule ligne, sans markdown : ' +
    '{"detected":"<langue source en français, ex: anglais, chinois, arabe, français>","translations":["...","..."]} — le tableau translations dans le MÊME ORDRE et la MÊME taille que l\'entrée.';
  const user = JSON.stringify(arr);
  let raw = await _claudeText(system, user, 2048);
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const j = JSON.parse(raw);
    const tr = Array.isArray(j.translations) ? j.translations : [];
    // garantir la même taille
    const out = arr.map(function(orig, i){ return (tr[i] != null && String(tr[i]).trim()) ? String(tr[i]) : orig; });
    return { detected: String(j.detected || '').trim() || 'inconnue', translations: out };
  } catch { return { detected: 'inconnue', translations: arr }; }
}
// Traduit le texte de Hakim (français) vers la langue du client.
async function translateToLang(text, langLabel) {
  const t = String(text || '').trim();
  if (!t) return '';
  const lang = String(langLabel || '').trim();
  if (!lang || /fran[çc]ais|french|^fr$/i.test(lang)) return t; // déjà la bonne langue
  const system =
    'Tu traduis le message de l\'hôte (Hakim) vers la langue cible indiquée, pour l\'envoyer au voyageur. ' +
    'Traduis fidèlement, garde le ton humain et professionnel, n\'ajoute rien. ' +
    'Renvoie UNIQUEMENT la traduction, rien d\'autre (pas de guillemets, pas d\'explication).';
  const user = 'Langue cible : ' + lang + '\n\nMessage à traduire :\n' + t;
  let out = await _claudeText(system, user, 1024);
  return out.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```\s*$/, '').replace(/^["«»\s]+|["«»\s]+$/g, '').trim() || t;
}

// ── Base de connaissances par logement (fiche IA, #5) ────────
// Lit la colonne logements.kb (jsonb) par nom d'appartement. Best-effort.
async function getApartmentKB(appartName) {
  if (!appartName) return null;
  try {
    const rows = await sbGet(`logements?nom=eq.${encodeURIComponent(appartName)}&select=kb&limit=1`);
    const kb = rows?.[0]?.kb;
    return (kb && typeof kb === 'object' && Object.keys(kb).length) ? kb : null;
  } catch { return null; }
}
// Construit le bloc d'infos injecté dans le prompt + la règle code serrure (toujours présente).
function kbBlock(kb) {
  const lines = [];
  if (kb) {
    if (kb.titre) lines.push(`Titre de l'annonce (marketing) : ${kb.titre}`);
    if (kb.wifi_nom || kb.wifi_code) lines.push(`Wifi — réseau : "${kb.wifi_nom || '—'}", mot de passe : "${kb.wifi_code || '—'}" (tu peux le communiquer)`);
    if (kb.adresse_etage) lines.push(`Adresse / étage : ${kb.adresse_etage}`);
    if (kb.gmaps) lines.push(`Lien Google Maps du logement (donne CE lien exact si on demande la localisation, ne le modifie pas) : ${kb.gmaps}`);
    if (kb.checkin_heure) lines.push(`Heure de check-in : ${kb.checkin_heure}`);
    if (kb.checkout)      lines.push(`Heure de check-out : ${kb.checkout}`);
    if (kb.checkin_acces) lines.push(`Accès / arrivée : ${kb.checkin_acces}`);
    if (kb.parking)       lines.push(`Parking : ${kb.parking}`);
    if (kb.environs)      lines.push(`Environs / quartier & transports : ${kb.environs}`);
    if (kb.equipements)   lines.push(`Équipements : ${kb.equipements}`);
    if (kb.services)      lines.push(`Services additionnels & tarifs : ${kb.services}`);
    if (kb.regles)        lines.push(`Règles de la maison : ${kb.regles}`);
    if (kb.faq)           lines.push(`Autres infos : ${kb.faq}`);
  }
  // Règle code serrure : TOUJOURS injectée, même sans fiche (politique Hakim).
  // La formulation dépend de la PHASE (voir règles de phase) : avant l'arrivée = "envoyé le jour
  // de l'arrivée après vérification des pièces d'identité" ; déjà sur place = il l'a déjà, ne pas en reparler.
  const lockRule =
    '\n\nRÈGLE ABSOLUE — CODE DE SERRURE / PORTE DIGITALE : ne donne JAMAIS le code de serrure ou de porte ' +
    'dans ta réponse (le mot de passe Wifi, lui, peut toujours être communiqué). Adapte selon la phase du séjour : ' +
    'avant l\'arrivée → il sera envoyé le jour de l\'arrivée après vérification des pièces d\'identité ; ' +
    'séjour déjà en cours → le voyageur l\'a déjà reçu, n\'en reparle pas (sauf s\'il signale un souci).' +
    '\n\nRÈGLE ABSOLUE — LIENS / ADRESSE / URL : n\'invente JAMAIS de lien Google Maps, d\'adresse ou d\'URL. ' +
    'N\'utilise QUE les liens et adresses listés ci-dessus dans les informations vérifiées. ' +
    'Si le voyageur demande la localisation et qu\'aucun lien Google Maps n\'est fourni ci-dessus, ' +
    'réponds simplement que tu le lui envoies (ex. « je vous envoie la localisation tout de suite ») ' +
    'sans jamais fabriquer une URL maps.app.goo.gl ou autre.';
  if (!lines.length) return lockRule;
  return '\n\nINFORMATIONS VÉRIFIÉES DE CE LOGEMENT (utilise-les pour répondre précisément aux questions du voyageur ; n\'invente RIEN au-delà de ces infos) :\n' +
    lines.map(function(l){ return '- ' + l; }).join('\n') + lockRule;
}

// ── Playbook NEX-ESTATE — politiques & ton COMMUNS à tous les logements ──
// Extraits des vraies réponses de Hakim (rapport conversations réelles, 2026-06-16).
// Le SPÉCIFIQUE par logement reste dans la fiche (kbBlock) ; ICI = le partagé.
function globalPlaybook() {
  return '\n\nPLAYBOOK NEX-ESTATE (politiques et ton VALABLES POUR TOUS LES LOGEMENTS — basés sur les vraies réponses de Hakim) :\n' +
    '— TON : français par défaut, court, humain, chaleureux et professionnel ; emojis discrets et optionnels.\n' +
    '— AVANT RÉSERVATION : le numéro de téléphone / contact n\'est communiqué qu\'APRÈS confirmation de la réservation. Le tarif est FIXE et non négociable (le dire poliment et inviter à réserver si l\'offre convient). Si les dates ne sont plus disponibles, inviter à consulter le calendrier sur la plateforme. Usage commercial (shooting, événement) : renvoyer aux conditions de l\'annonce → brouillon à faire valider.\n' +
    '— INFOS & LOCALISATION AVANT RÉSERVATION : toutes les informations (localisation/quartier, description détaillée, équipements, conditions et règles du logement, photos) sont DÉJÀ sur l\'annonce de la plateforme (Airbnb/Booking) → inviter le prospect à les consulter sur l\'annonce, et s\'il est d\'accord à réserver. On peut donner les infos GÉNÉRALES (quartier, environs, équipements) mais l\'ADRESSE EXACTE, le CODE de serrure et la PROCÉDURE D\'ARRIVÉE détaillée ne sont communiqués qu\'APRÈS la réservation, via le guide voyageur (instructions d\'arrivée, photos de la résidence, etc.). Si un prospect demande la localisation précise AVANT de réserver : l\'inviter à réserver d\'abord (l\'annonce indique déjà le quartier et toutes les conditions) ; une fois la réservation passée, il reçoit le guide voyageur complet et on l\'accompagne/rassure jusqu\'à son arrivée.\n' +
    '— RÉSERVATIONS UNIQUEMENT VIA LA PLATEFORME : aucune réservation en direct, surtout pour les prospects qui contactent via les plateformes — toute réservation passe par Airbnb (client Airbnb) ou Booking (client Booking). INTERDIT de communiquer un numéro de téléphone ou un contact direct avant la réservation.\n' +
    '— SÉJOURS LONGUE DURÉE : nous ne sommes PAS une agence immobilière. Pour une location à l\'année ou de plusieurs mois, orienter poliment le client vers une agence immobilière (ne pas traiter ces demandes en direct). Le délai MAXIMUM d\'une réservation en location courte durée (réglementation marocaine) est de 60 JOURS — on ne peut pas accepter plus. Pour un séjour de plusieurs semaines / jusqu\'à un ou deux mois : c\'est possible via la plateforme, et les remises longue durée sont DÉJÀ appliquées automatiquement dans les tarifs affichés sur Airbnb/Booking (le dire : « les tarifs sont déjà à jour, avec une remise spéciale longue durée »).\n' +
    '— DOCUMENTS / CHECK-IN (réglementation marocaine, requis AVANT l\'arrivée) : pièce d\'identité recto-verso de chaque voyageur, nombre exact de voyageurs, et acte de mariage pour les couples. La photo d\'identité peut être masquée (ex. raison religieuse / foulard) MAIS le numéro et les informations administratives doivent rester lisibles. Le contrat est en français (langue administrative officielle au Maroc) : proposer un traducteur si besoin.\n' +
    '— CONTRAT PAPIER À L\'ARRIVÉE (procédure GÉNÉRALE, valable pour TOUS les logements et CHAQUE séjour) : à son arrivée, le voyageur trouve dans le logement un contrat papier et un stylo. S\'il accède en autonomie (aucun agent terrain sur place), il doit le remplir avec ses informations, le signer, inscrire la date du jour sur la dernière page, photographier TOUTES les pages et les envoyer à l\'hôte par WhatsApp ou via la messagerie de la plateforme. Si un agent terrain est présent à l\'arrivée, c\'est lui qui s\'occupe du contrat.\n' +
    '— PERSONNES DÉCLARÉES : seules les personnes déclarées sur la réservation peuvent accéder au logement ; toute personne supplémentaire (ami, famille) doit être déclarée (mettre à jour le nombre de voyageurs sur la plateforme). Ne jamais dépasser la capacité de l\'annonce.\n' +
    '— CONSOMMABLES : 1 à 2 rouleaux de papier toilette sont fournis à l\'arrivée ; au-delà, le voyageur peut en racheter au supermarché à proximité.\n' +
    '— ÉQUIPEMENTS (tous les logements) : aucun aspirateur électrique, mais un balai et une raclette de sol sont disponibles. Climatisation = service optionnel à 3 €/nuit (même si l\'annonce montre la clim) : à activer sur demande après paiement ; rappeler d\'éteindre la clim de la chambre pendant l\'usage de l\'eau chaude / la douche.\n' +
    '— ARRIVÉE ANTICIPÉE / DÉPART TARDIF (NE PAS CONFONDRE — erreur fréquente) : le check-in standard est à partir de 15h, le check-out avant 11h. Le supplément (≈10 €, voir la fiche du logement) s\'applique UNIQUEMENT dans 2 cas : (a) ARRIVÉE plus TÔT que 15h (arrivée anticipée), ou (b) DÉPART plus TARD que 11h (départ tardif, jusqu\'à 13h ou 13h30 selon le logement). En revanche, si le voyageur veut PARTIR AVANT 11h (départ anticipé / plus tôt que l\'heure de check-out) : AUCUN supplément, rien à facturer, c\'est sans aucun problème (au contraire). NE JAMAIS proposer de service payant pour un départ avant 11h. Bien distinguer « arriver tôt » (payant) de « partir tôt » (gratuit), et « partir tard » (payant) de « partir tôt » (gratuit).\n' +
    '— LOCALISATION : donner le lien Google Maps de la fiche + préciser que le guide voyageur contient les instructions d\'arrivée.\n' +
    '— MODIFICATION DE DATES : ne jamais confirmer sans vérifier le calendrier → brouillon à faire valider par Hakim.\n' +
    '— ESCALADE (NE PAS répondre seul, laisser Hakim valider) : personnes non déclarées détectées pendant le séjour, conflit ou tension, mention de la police ou d\'un remboursement, litige. Pour une panne / problème technique : rassurer brièvement et indiquer que tu organises l\'intervention (Hakim suit).\n' +
    '— RÈGLE ABSOLUE : aucune réponse n\'est envoyée automatiquement ; tu proposes toujours un brouillon que Hakim relit et valide.';
}

// ── Voix de Hakim — guide de style distillé de ses vraies conversations ──
// (Qualitatif : le TON et la MANIÈRE. Les exemples concrets viennent en plus via
// getHakimStyleExamples sur ses réponses réellement envoyées.)
function hakimStyleGuide() {
  return '\n\nVOIX DE HAKIM (imite cette manière d\'écrire) :\n' +
    '— ⚡ RÈGLE N°1, LA PLUS IMPORTANTE — BREF ET DIRECT. Réponds UNIQUEMENT à ce qui est demandé, en 1 à 3 phrases courtes MAXIMUM. Cette règle PRIME sur toutes les autres : si le ton « chaleureux » te pousse à rallonger, RACCOURCIS.\n' +
    '— ⚡ INTERDIT (ce qui rend les messages trop chargés) : phrases de bienvenue émotionnelles ou marketing (« quelle joie de vous accueillir », « c\'est beau de revenir à Rabat », « profitez pleinement de votre séjour »), compliments, répétitions, ET toute formule de clôture non demandée (« au plaisir de vous accueillir bientôt », « si vous avez besoin de quoi que ce soit n\'hésitez pas »). Structure type = salutation courte + la réponse, point final.\n' +
    '— ⚡ QUAND HAKIM DONNE UNE CONSIGNE : exécute EXACTEMENT cette consigne et RIEN d\'autre. N\'ajoute aucune phrase décorative autour. Ex : consigne « demande à la cliente de remplir le formulaire de check-in » → réponse attendue ≈ « Bonjour Fatima, merci de remplir le formulaire de check-in avant votre arrivée. » — PAS de speech de bienvenue avant, PAS de « au plaisir » après.\n' +
    '— ⚡ SALUTATION OBLIGATOIREMENT PERSONNALISÉE AVEC LE PRÉNOM (fourni dans le contexte) : « Bonjour <Prénom>, » / « Salam <Prénom>, » / « Hello <Prénom>, » selon la langue du client. INTERDIT de saluer sans le prénom (jamais « Bonjour » seul, « Salut », « Hi », « Hello » tout court) quand le prénom est connu. Puis on enchaîne DIRECTEMENT sur la réponse. JAMAIS faire suivre la salutation d\'une formule d\'enthousiasme du type « quelle joie de vous accueillir », « ravi de vous recevoir » — c\'est le remplissage à supprimer. Pour un homme marocain : « Ssi »/« Si » + prénom (« Bonjour Ssi Abdellah »). Si le client salue en arabe/darija (« Salam »), réponds « Salam <Prénom> ». Mire toujours la langue du client.\n' +
    '— Reste POSÉ et courtois même face à l\'agressivité ; ne te justifie jamais avec agacement. Un seul « merci » si pertinent, pas plus.\n' +
    '— Pour un refus ou une règle : explique le pourquoi en UNE phrase courte (réglementation, sécurité, copropriété) et propose une solution concrète — jamais un « non » sec, mais sans t\'étaler.\n' +
    '— Couples non mariés : INFORMER de la réglementation locale sans refuser d\'office, recentrer sur le respect du logement ; ne JAMAIS improviser un refus → laisser Hakim valider.\n' +
    '— Suppléments (clim, arrivée anticipée, départ tardif, serviettes) : proposer une demande de paiement via Airbnb ; sinon règlement sur place.\n' +
    '— Ton humain, jamais robotique. Emoji RARE (0 à 1 maximum). Signature courte « Hakim – Nex Estate » seulement si le message s\'y prête (pas sur une réponse à une simple question). N\'ajoute PAS de clôture longue par défaut.';
}

// ── Enrichir depuis la table resa (via smoobu_id) ────────────
// Retourne { id, appart, voyageur, source, checkin, checkout } ou {}
async function getResaContext(smoobuBookingId) {
  try {
    const sid  = encodeURIComponent(String(smoobuBookingId));
    const rows = await sbGet(
      `resa?smoobu_id=eq.${sid}&select=id,appart,voyageur,source,checkin,checkout,adults,children&limit=1`
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

// ── Fuseau du compte Smoobu → UTC réel ───────────────────────
// Smoobu renvoie ses dates dans le fuseau configuré du compte (Europe/Paris),
// SANS suffixe de fuseau (ex: "2026-06-15 11:53:38"). Sur Vercel (UTC), `new Date()`
// les interprète à tort comme de l'UTC → décalage de +1h (hiver) / +2h (été) qui
// faisait remonter les réponses CRM (vrai UTC) au-dessus des messages voyageur.
// On interprète donc la date naïve en Europe/Paris et on renvoie l'instant UTC réel.
function parisOffsetMin(utcMs) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Paris', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = dtf.formatToParts(new Date(utcMs)).reduce(function(a, x){ a[x.type] = x.value; return a; }, {});
    const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asIfUTC - utcMs) / 60000); // +60 (hiver) ou +120 (été)
  } catch (e) { return 120; } // fallback CEST
}
function smoobuDateToUTC(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;
  // Déjà un fuseau explicite (Z ou +hh:mm) → ne pas re-décaler.
  if (/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(str)) {
    const d0 = new Date(str);
    return isNaN(d0.getTime()) ? null : d0;
  }
  const m = str.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d1 = new Date(str);
    return isNaN(d1.getTime()) ? null : d1;
  }
  const guessUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return new Date(guessUTC - parisOffsetMin(guessUTC) * 60000);
}

// ── Extraire la date d'un message Smoobu ─────────────────────
// Smoobu peut utiliser différents noms de champ selon la version API
function extractMessageDate(msg) {
  const raw = msg.created_at || msg.createdAt || msg.sentAt || msg.sent_at
            || msg.date || msg.timestamp || msg.updatedAt || '';
  if (!raw) return null;
  try {
    return smoobuDateToUTC(raw);
  } catch { return null; }
}

// ── Trier les messages chronologiquement (ASC = plus ancien en premier) ──
// Smoobu peut retourner les messages en ASC ou en DESC selon la version API.
// Stratégie 1 : tri par date si disponible (champ created_at / sentAt / ...).
// Stratégie 2 : tri par ID numérique Smoobu (ID plus grand = message plus récent).
// Stratégie 3 : pas de critère → garder l'ordre API (risque de DESC).
function sortMessagesChronologically(messages) {
  if (!messages || messages.length < 2) return messages || [];

  // Stratégie 1 — dates
  const withDates = messages.map(function(m, i) {
    return { msg: m, d: extractMessageDate(m), i: i };
  });
  const dateCount = withDates.filter(function(x) { return x.d !== null; }).length;
  if (dateCount >= Math.ceil(messages.length / 2)) {
    withDates.sort(function(a, b) {
      if (!a.d && !b.d) return a.i - b.i;
      if (!a.d) return 1;
      if (!b.d) return -1;
      return a.d.getTime() - b.d.getTime();
    });
    return withDates.map(function(x) { return x.msg; });
  }

  // Stratégie 2 — IDs numériques Smoobu (séquentiels croissants)
  const withIds = messages.map(function(m, i) {
    const raw = m.id || m.messageId || m.message_id || m.messageID || '';
    const n = parseInt(String(raw), 10);
    return { msg: m, id: isNaN(n) ? null : n, i: i };
  });
  const idCount = withIds.filter(function(x) { return x.id !== null; }).length;
  if (idCount >= Math.ceil(messages.length / 2)) {
    withIds.sort(function(a, b) {
      if (a.id === null && b.id === null) return a.i - b.i;
      if (a.id === null) return 1;
      if (b.id === null) return -1;
      return a.id - b.id; // ASC : ID plus bas = plus ancien
    });
    return withIds.map(function(x) { return x.msg; });
  }

  // Stratégie 3 — aucun critère détectable
  return messages.slice();
}

// ── Analyser l'état de la conversation (utilisé par sync ET debug) ──
function analyzeConversation(sortedMessages) {
  let lastGuestIdx = -1;
  let lastHostIdx  = -1;
  for (let i = sortedMessages.length - 1; i >= 0; i--) {
    const txt = extractMessageText(sortedMessages[i]);
    if (!txt) continue;
    if (isGuestMessage(sortedMessages[i])) {
      if (lastGuestIdx === -1) lastGuestIdx = i;
    } else {
      if (lastHostIdx  === -1) lastHostIdx  = i;
    }
    if (lastGuestIdx !== -1 && lastHostIdx !== -1) break;
  }
  const hostRepliedAfter = lastGuestIdx !== -1 &&
    sortedMessages.slice(lastGuestIdx + 1).some(function(m) {
      return !isGuestMessage(m) && extractMessageText(m).length > 0;
    });
  return { lastGuestIdx, lastHostIdx, hostRepliedAfter };
}

// ── Transcript des derniers messages du voyageur ─────────────
// Le client écrit souvent sa demande en plusieurs messages successifs ("Bonjour"
// puis la vraie question). On fournit les 5 derniers à l'IA pour qu'elle réponde
// à l'ensemble. Retourne { text, multi } (multi = au moins 2 messages).
function buildGuestTranscript(allMessages) {
  const now = Date.now();
  const recent = (allMessages || [])
    .filter(function(m){ return isGuestMessage(m) && extractMessageText(m).length > 0; })
    .slice(-5)
    .map(function(m){
      const txt = extractMessageText(m);
      const dt  = extractMessageDate(m);
      let rel = '';
      if (dt) {
        const d = new Date(dt);
        const days = Math.floor((now - d.getTime()) / 86400000);
        const dm = ('0'+d.getUTCDate()).slice(-2)+'/'+('0'+(d.getUTCMonth()+1)).slice(-2);
        rel = ' · ' + dm + (days<=0 ? ' (aujourd\'hui)' : (days===1 ? ' (hier)' : ' (il y a '+days+' jours)'));
      }
      return '[Voyageur'+rel+'] '+txt;
    });
  return { text: recent.join('\n'), multi: recent.length > 1 };
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

// ── Détecte un message trivial ne nécessitant pas de réponse ──
// Retourne true → classification no_reply_needed, Claude ignoré
function isTrivialMessage(text) {
  var t = (text || '').trim();
  if (!t) return true;

  // Message avec question → jamais trivial (réponse potentiellement requise)
  if (t.indexOf('?') !== -1) return false;

  var tl = t.toLowerCase();

  // Mots-clés d'alerte → jamais trivial même si message court
  var alertKeywords = [
    'problème', 'problem', 'cassé', 'broken', 'sale', 'dirty', 'froid', 'cold',
    'chaud', 'hot', 'bruit', 'noise', 'urgent', 'aide', 'help', 'manque',
    'panne', 'erreur', 'error', 'pas reçu', "n'ai pas", 'ne marche', "doesn't work",
    'annul', 'rembours', 'refund', 'cancel', 'plainte', 'complaint', 'dommage',
  ];
  if (alertKeywords.some(function(w) { return tl.indexOf(w) !== -1; })) return false;

  // Court (≤ 30 chars) et sans alerte → très probablement trivial
  if (tl.length <= 30) return true;

  // Patterns triviaux connus au-delà de 30 chars
  var trivialPatterns = [
    /^(merci (beaucoup|infiniment|bien|mille fois|pour tout|pour (votre |ta )?(réponse|aide|message|retour|info|disponibilité)))[!.,\s🙏]*$/,
    /^(thank you (so much|very much|for (your|the) (quick )?reply|for everything|for your help))[!.,\s]*$/,
    /^(j'?ai (bien )?trouvé|found (it|the place|the apartment|your place))[!.,\s]*$/,
    /^(à tout à l'heure|a tout (à )?l'heure|see you( (soon|later|then))?)[!.,\s]*$/,
    /^(bonne (journée|soirée|nuit|route|continuation|fin de semaine))[!.,!\s]*$/,
    /^(je vous en prie|no problem|no worries|pas de problème|pas de souci|c'est normal)[!.,\s]*$/,
    /^(d'accord (pour|c'est|je serai|on se)[ \w]{0,25})[!.,\s]*$/,
    /^(bien reçu[.,!]?\s*(merci)?)[!.,\s]*$/,
  ];
  return trivialPatterns.some(function(r) { return r.test(tl); });
}

// ── Calcule le nombre de jours jusqu'au check-in ─────────────
// Retourne un entier (négatif = passé, 0 = aujourd'hui, null si date invalide)
function daysUntilCheckin(checkinStr) {
  if (!checkinStr) return null;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(checkinStr + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    return Math.round((d - today) / 86400000);
  } catch { return null; }
}

// ── Phase du séjour (où en est le voyageur) ──────────────────
// Retourne { key, label } : avant / veille / arrivee / encours / depart / termine.
// Permet à l'IA d'adapter sa réponse (déjà sur place ≠ pas encore venu).
function stayPhase(checkin, checkout) {
  if (!checkin) return { key:'inconnu', label:'dates non précisées' };
  const today = new Date(); today.setHours(0,0,0,0);
  const ci = new Date(checkin + 'T00:00:00');
  if (isNaN(ci.getTime())) return { key:'inconnu', label:'dates non précisées' };
  const dCi = Math.round((ci - today) / 86400000);
  if (dCi > 1)  return { key:'avant',  label:'AVANT l\'arrivée (arrive dans ' + dCi + ' jours, le ' + checkin + ')' };
  if (dCi === 1) return { key:'veille', label:'arrive DEMAIN (' + checkin + ')' };
  if (dCi === 0) return { key:'arrivee', label:'arrive AUJOURD\'HUI (' + checkin + ')' };
  // dCi < 0 → déjà arrivé
  const co = checkout ? new Date(checkout + 'T00:00:00') : null;
  if (co && !isNaN(co.getTime())) {
    const dCo = Math.round((co - today) / 86400000);
    if (dCo > 0)  return { key:'encours', label:'SÉJOUR EN COURS — le voyageur est DÉJÀ sur place (arrivé le ' + checkin + ', départ le ' + checkout + ')' };
    if (dCo === 0) return { key:'depart',  label:'DÉPART AUJOURD\'HUI (' + checkout + ') — le voyageur est encore/déjà sur place' };
    return { key:'termine', label:'séjour TERMINÉ (départ le ' + checkout + ')' };
  }
  return { key:'encours', label:'SÉJOUR EN COURS — le voyageur est probablement déjà sur place (arrivé le ' + checkin + ')' };
}

// ── Vérifie si le message Smoobu actuel === celui déjà en DB ──
// Compare par smoobu_message_id si dispo, sinon par préfixe contenu
function isSameMessage(existingRecord, currentSmoobuMsgId, currentContent) {
  if (existingRecord.smoobu_message_id && currentSmoobuMsgId) {
    return existingRecord.smoobu_message_id === String(currentSmoobuMsgId);
  }
  const a = (existingRecord.message_content || '').trim().slice(0, 200);
  const b = (currentContent || '').trim().slice(0, 200);
  return a === b;
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

  // ── Conversation par client : GET ?conversation=BOOKING_ID ───
  // Retourne le fil complet d'une réservation : messages voyageur ET réponses hôte
  // (Smoobu, lecture seule, grâce à onlyRelatedToGuest=false) + réponses envoyées via
  // le CRM (table messages, statut=sent), triés par date. Les réponses hôte tapées
  // directement dans Airbnb/Booking/Smoobu remontent désormais (type=2).
  if (req.method === 'GET' && req.query?.conversation) {
    const cid = String(req.query.conversation).trim();
    if (!cid) return res.status(400).json({ error: 'conversation: booking_id requis' });
    try {
      // 1. Réponses envoyées via le CRM (host) — TOUJOURS lues depuis NOTRE base.
      //    Elles ne dépendent pas de l'API Smoobu : même si Smoobu est en panne,
      //    Hakim doit toujours voir ce qu'il a déjà envoyé.
      let crmReplies = [];
      try {
        const sentRows = await sbGet(
          `messages?smoobu_booking_id=eq.${encodeURIComponent(cid)}&statut=eq.sent&select=ai_draft,sent_at,updated_at&order=sent_at.asc`
        );
        crmReplies = (sentRows || [])
          .map(function(r){ return { sender: 'host', text: (r.ai_draft || '').trim(), at: r.sent_at || r.updated_at || null, via_crm: true }; })
          .filter(function(x){ return x.text; });
      } catch (e) { console.warn('[messages] conversation: lecture CRM échouée:', e.message); }

      // 2. Messages voyageur depuis Smoobu — best-effort : un échec/404 NE doit PAS
      //    effacer les réponses CRM. On isole l'appel dans son propre try.
      let guestMsgs = [];
      let smoobuOk = true;
      try {
        const msgData = await getSmoobuMessages(cid);
        const raw = msgData?.messages || msgData?.data || (Array.isArray(msgData) ? msgData : []);
        const sorted = sortMessagesChronologically(raw);
        guestMsgs = sorted
          .map(function(m){
            const d = extractMessageDate(m);
            return {
              sender: isGuestMessage(m) ? 'guest' : 'host',
              text:   extractMessageText(m),
              at:     d ? d.toISOString() : null,
            };
          })
          .filter(function(x){ return x.text; });
      } catch (e) {
        smoobuOk = false;
        console.warn('[messages] conversation: Smoobu indisponible (booking ' + cid + '):', e.message);
      }

      // 3. Anti-doublon host : Smoobu renvoie désormais les réponses hôte (type=2),
      //    y compris celles ENVOYÉES via le CRM (poussées vers Smoobu à l'envoi). On ne
      //    garde donc du côté CRM que les réponses ABSENTES du fil Smoobu — envois trop
      //    récents pas encore synchronisés, ou repli si Smoobu est indisponible.
      const _normMsg = function(t){
        return String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
      };
      const smoobuHostSet = new Set(
        guestMsgs.filter(function(m){ return m.sender === 'host' && m.text; }).map(function(m){ return _normMsg(m.text); })
      );
      const crmRepliesDedup = crmReplies.filter(function(r){ return !smoobuHostSet.has(_normMsg(r.text)); });

      // 4. Fusion + tri chronologique (les sans-date à la fin, ordre conservé)
      const all = guestMsgs.concat(crmRepliesDedup).sort(function(a, b){
        if (!a.at && !b.at) return 0;
        if (!a.at) return 1;
        if (!b.at) return -1;
        return new Date(a.at) - new Date(b.at);
      });
      return res.status(200).json({ ok: true, booking_id: cid, count: all.length, smoobu_ok: smoobuOk, messages: all });
    } catch (err) {
      console.error('[messages] conversation error (booking ' + cid + '):', err.message);
      return res.status(200).json({ ok: false, booking_id: cid, messages: [], error: 'Conversation indisponible' });
    }
  }

  // ── Conversations récentes : GET ?recentConversations=1 ──────
  // Liste les dernières réservations ayant eu une activité (message voyageur
  // OU réponse CRM), groupées par booking, pour retrouver un fil sans chercher
  // le nom à la main. Lecture seule, 100% depuis NOTRE base (pas l'API Smoobu).
  if (req.method === 'GET' && req.query?.recentConversations) {
    try {
      // Filtre date optionnel (YYYY-MM-DD) : ne renvoie que les conversations ayant
      // eu une activité ce jour-là (jour UTC). Sans date = 20 plus récentes.
      const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : '';
      let dateClause = '';
      if (dateParam) {
        const nx = new Date(dateParam + 'T00:00:00Z'); nx.setUTCDate(nx.getUTCDate() + 1);
        const nxStr = nx.toISOString().slice(0, 10);
        dateClause = `&created_at=gte.${dateParam}&created_at=lt.${nxStr}`;
      }
      const rows = await sbGet(
        'messages?smoobu_booking_id=not.is.null' +
        '&select=smoobu_booking_id,voyageur,appart,source,sender,message_content,ai_draft,detected_language,client_summary_fr,created_at,sent_at,statut' +
        dateClause +
        '&order=created_at.desc&limit=' + (dateParam ? '300' : '150')
      );
      const byBooking = {};
      (rows || []).forEach(function(r){
        const k = String(r.smoobu_booking_id);
        const ts = r.sent_at || r.created_at || null;
        const cur = byBooking[k];
        // On garde la ligne la plus récente comme "tête" de conversation.
        if (!cur || (ts && (!cur._ts || new Date(ts) > new Date(cur._ts)))) {
          const isHost = r.sender === 'host';
          byBooking[k] = {
            booking_id: k,
            voyageur:   r.voyageur || (cur && cur.voyageur) || null,
            appart:     r.appart   || (cur && cur.appart)   || null,
            source:     r.source   || (cur && cur.source)   || null,
            detected_language: r.detected_language || (cur && cur.detected_language) || null,
            last_at:    ts,
            last_by:    isHost ? 'host' : 'guest',
            last_text:  (isHost ? (r.ai_draft || '') : (r.client_summary_fr || r.message_content || '')).replace(/\s+/g, ' ').trim().slice(0, 90),
            _ts:        ts,
          };
        } else if (cur) {
          // Compléter les champs manquants depuis d'autres lignes du même booking.
          if (!cur.voyageur && r.voyageur) cur.voyageur = r.voyageur;
          if (!cur.appart   && r.appart)   cur.appart   = r.appart;
          if (!cur.source   && r.source)   cur.source   = r.source;
          if (!cur.detected_language && r.detected_language) cur.detected_language = r.detected_language;
        }
      });
      const list = Object.keys(byBooking).map(function(k){ const o = byBooking[k]; delete o._ts; return o; })
        .sort(function(a, b){
          if (!a.last_at && !b.last_at) return 0;
          if (!a.last_at) return 1;
          if (!b.last_at) return -1;
          return new Date(b.last_at) - new Date(a.last_at);
        })
        .slice(0, dateParam ? 100 : 20);
      return res.status(200).json({ ok: true, count: list.length, conversations: list });
    } catch (err) {
      console.error('[messages] recentConversations error:', err.message);
      return res.status(200).json({ ok: false, conversations: [], error: err.message });
    }
  }

  // ── Debug booking : GET ?debugBooking=ID ─────────────────
  // Retourne l'état complet de la conversation Smoobu + décision sync
  // pour un booking donné — sans modifier aucune donnée.
  if (req.method === 'GET' && req.query?.debugBooking) {
    const bookingId = parseInt(req.query.debugBooking, 10);
    if (!bookingId || isNaN(bookingId)) {
      return res.status(400).json({ error: 'debugBooking: ID numérique requis' });
    }
    if (!SMOOBU_KEY) return res.status(503).json({ error: 'SMOOBU_API_KEY manquante' });
    try {
      // 1. État en DB
      const dbRows = await sbGet(
        `messages?smoobu_booking_id=eq.${bookingId}&select=id,statut,classification,is_stale,message_content,smoobu_message_id,created_at,updated_at&order=created_at.desc`
      );

      // 2. Messages Smoobu bruts
      const msgData  = await getSmoobuMessages(bookingId);
      const rawMsgs  = msgData?.messages || msgData?.data || (Array.isArray(msgData) ? msgData : []);

      // 3. Inspecter chaque message brut (tous les champs)
      const rawInspect = rawMsgs.map(function(m, i) {
        return {
          api_index:        i,
          raw_id:           m.id ?? m.messageId ?? m.message_id ?? null,
          raw_type:         m.type,
          raw_sender:       m.sender,
          raw_date_fields:  {
            created_at: m.created_at ?? null,
            sentAt:     m.sentAt     ?? null,
            date:       m.date       ?? null,
            timestamp:  m.timestamp  ?? null,
            updatedAt:  m.updatedAt  ?? null,
          },
          all_keys:         Object.keys(m),
          detected_date:    extractMessageDate(m)?.toISOString() ?? null,
          detected_sender:  isGuestMessage(m) ? 'guest' : 'host',
          content_preview:  extractMessageText(m).slice(0, 100),
        };
      });

      // 4. Déterminer la stratégie de tri
      const dateCount = rawMsgs.filter(function(m) { return extractMessageDate(m) !== null; }).length;
      const idCount   = rawMsgs.filter(function(m) {
        const n = parseInt(String(m.id || m.messageId || m.message_id || ''), 10);
        return !isNaN(n);
      }).length;
      const sortStrategy = dateCount >= Math.ceil(rawMsgs.length / 2) ? 'date_asc'
        : idCount >= Math.ceil(rawMsgs.length / 2) ? 'id_asc'
        : 'api_order_unchanged';

      // 5. Trier et analyser
      const sorted = sortMessagesChronologically(rawMsgs);
      const { lastGuestIdx, lastHostIdx, hostRepliedAfter } = analyzeConversation(sorted);

      const lastGuestMsg = lastGuestIdx !== -1 ? sorted[lastGuestIdx] : null;
      const lastHostMsg  = lastHostIdx  !== -1 ? sorted[lastHostIdx]  : null;

      const sortedInspect = sorted.map(function(m, i) {
        return {
          sorted_index:    i,
          raw_id:          m.id ?? m.messageId ?? m.message_id ?? null,
          detected_sender: isGuestMessage(m) ? 'guest' : 'host',
          detected_date:   extractMessageDate(m)?.toISOString() ?? null,
          content_preview: extractMessageText(m).slice(0, 100),
        };
      });

      // 6. Décision attendue
      const pendingInDb = (dbRows || []).filter(function(r) { return r.statut === 'pending'; });
      let decision, reason;
      if (lastGuestIdx === -1) {
        decision = 'SKIP_NO_GUEST_MESSAGE';
        reason   = 'Aucun message voyageur avec contenu dans la conversation';
      } else if (hostRepliedAfter) {
        decision = pendingInDb.length > 0 ? 'AUTO_RESOLVE' : 'SKIP_NO_PENDING';
        reason   = pendingInDb.length > 0
          ? `${pendingInDb.length} record(s) pending seront passés en resolved`
          : 'Hôte a répondu mais aucun pending en DB';
      } else {
        const isStale = pendingInDb.some(function(r) { return r.is_stale; });
        decision = pendingInDb.length > 0
          ? (isStale ? 'UPDATE_STALE_REGEN' : 'SKIP_SAME_OR_UPDATE')
          : 'INSERT_NEW';
        reason = pendingInDb.length > 0
          ? (isStale ? 'Record stale + même message → Claude regénérera le brouillon au prochain sync'
            : 'isSameMessage sera évalué : skip si identique, sinon update')
          : 'Nouveau record sera inséré';
      }

      return res.status(200).json({
        booking_id: bookingId,
        db_records: dbRows || [],
        smoobu: {
          raw_count:      rawMsgs.length,
          sort_strategy:  sortStrategy,
          sort_note:      { date_asc: 'trié par date ASC', id_asc: 'trié par ID numérique ASC', api_order_unchanged: '⚠ pas de date ni d\'ID numérique — ordre API conservé (peut être DESC)' }[sortStrategy],
          raw_messages:   rawInspect,
          sorted_messages: sortedInspect,
        },
        analysis: {
          last_guest_message: lastGuestMsg ? {
            sorted_index:    lastGuestIdx,
            content:         extractMessageText(lastGuestMsg),
            date:            extractMessageDate(lastGuestMsg)?.toISOString() ?? null,
            raw_id:          lastGuestMsg.id ?? lastGuestMsg.messageId ?? null,
          } : null,
          last_host_message: lastHostMsg ? {
            sorted_index:    lastHostIdx,
            content:         extractMessageText(lastHostMsg),
            date:            extractMessageDate(lastHostMsg)?.toISOString() ?? null,
            raw_id:          lastHostMsg.id ?? lastHostMsg.messageId ?? null,
          } : null,
          host_replied_after: hostRepliedAfter,
          decision,
          reason,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,5) });
    }
  }

  // ── Sync threads : GET ?sync=1 ────────────────────────────
  // Appel périodique (cron Vercel) ou manuel.
  // Récupère les threads Smoobu récents et insère dans `messages`
  // les messages voyageurs non encore capturés (filet de sécurité webhook).
  // Paramètre optionnel : ?hours=N (défaut 24) — fenêtre de recherche.
  if (req.method === 'GET' && req.query?.sync) {
    if (!SMOOBU_KEY) return res.status(503).json({ error: 'SMOOBU_API_KEY manquante' });
    try {
      const hoursBack = Math.min(parseInt(req.query.hours || '48', 10) || 48, 48);
      const since = new Date(Date.now() - hoursBack * 3600 * 1000);
      console.log('[sync] démarrage — fenêtre:', hoursBack, 'h | since:', since.toISOString());

      // ── 0. Expiration automatique des pending obsolètes (> 48h) ──
      // Hakim répond TOUJOURS sur la plateforme en < 1h (règle Superhost). Or l'API
      // Smoobu n'expose PAS les messages hôte (tous les messages sont type=1 guest,
      // vérifié sur booking 140560917 : 11/11 type=1) → impossible de détecter sa
      // réponse. Conclusion : tout pending de plus de 48h est par définition déjà
      // traité ailleurs → résolu automatiquement (ignored si sans-réponse).
      let expired = 0;
      try {
        const cutoff  = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        const nowExp  = new Date().toISOString();
        const oldPend = await sbGet(
          `messages?statut=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&select=id,classification&limit=100`
        );
        for (const op of (oldPend || [])) {
          await sbPatch('messages', `id=eq.${encodeURIComponent(op.id)}`, {
            statut:     op.classification === 'no_reply_needed' ? 'ignored' : 'resolved',
            updated_at: nowExp,
          });
          expired++;
        }
        if (expired) console.log('[sync] expiration 48h —', expired, 'pending auto-résolus');
      } catch (expErr) {
        console.warn('[sync] expiration error:', expErr.message);
      }

      // ── 1. Collecter les threads récents (pagination) ─────
      const recentThreads = [];
      let page = 1;
      let done = false;

      while (!done) {
        const r = await smoobuFetch(`/api/threads`, {
          query: { page_number: page, page_size: 20 },
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

      // ── 2. Pré-charger tous les pending existants en DB (1 seule requête batch) ──
      // Évite N requêtes individuelles par thread — accès O(1) par booking_id
      let allPendingInDb = [];
      try {
        allPendingInDb = await sbGet(
          'messages?statut=eq.pending&select=id,smoobu_booking_id,smoobu_message_id,message_content,created_at,is_stale,updated_at&order=created_at.desc&limit=300'
        ) || [];
      } catch (batchErr) {
        console.warn('[sync] impossible de pré-charger les pending:', batchErr.message);
      }
      const pendingByBooking = {};
      for (const p of allPendingInDb) {
        const bid = String(p.smoobu_booking_id);
        if (!pendingByBooking[bid]) pendingByBooking[bid] = [];
        pendingByBooking[bid].push(p); // déjà triés desc par created_at
      }

      // ── 3. Traiter chaque thread (cap 10 AI/run) ──────────
      let processed = 0, skipped = 0, resolved = 0, errors = 0, aiUsed = 0;
      const MAX_AI_PER_SYNC = 10;

      for (const thread of recentThreads) {
        const bookingId  = thread.booking.id;
        const guestName  = thread.booking.guest_name || '';
        const appart     = thread.apartment?.name    || '';

        try {
          // ── Layer 1 : détection au niveau du thread (signal plus fiable que type individuel)
          // Smoobu /reservations/{id}/messages retourne TOUS les messages avec type=1 (guest)
          // → latest_message.type (1=guest, ≠1=host) et unread_messages_count=0 sont les vrais signaux
          const latestMsgType = thread.latest_message?.type;
          const unreadCount   = thread.unread_messages_count ?? thread.unreadMessagesCount ?? null;
          const hostHandledAtThreadLevel =
            (typeof latestMsgType === 'number' && latestMsgType !== 1) ||
            (unreadCount !== null && Number(unreadCount) === 0);

          if (hostHandledAtThreadLevel) {
            const existingPendingTL = pendingByBooking[String(bookingId)] || [];
            if (existingPendingTL.length > 0) {
              const now = new Date().toISOString();
              for (const ep of existingPendingTL) {
                await sbPatch('messages', `id=eq.${encodeURIComponent(ep.id)}`, {
                  statut:     'resolved',
                  updated_at: now,
                });
              }
              resolved += existingPendingTL.length;
              console.log('[sync] thread-level auto-resolved', existingPendingTL.length,
                'pending — booking:', bookingId,
                '| latestMsgType:', latestMsgType, '| unread:', unreadCount);
            }
            skipped++;
            continue;
          }

          // Lire les messages complets de la réservation
          const msgData    = await getSmoobuMessages(bookingId);
          const rawMessages = msgData?.messages || msgData?.data || (Array.isArray(msgData) ? msgData : []);
          // Trier chronologiquement ASC (Smoobu peut retourner DESC)
          const allMessages = sortMessagesChronologically(rawMessages);

          // Analyser l'état de la conversation
          const { lastGuestIdx, hostRepliedAfter } = analyzeConversation(allMessages);

          // Pending existants pour ce booking (depuis le batch pré-chargé)
          const existingPending = pendingByBooking[String(bookingId)] || [];

          // ── Cas A : hôte a répondu OU pas de message voyageur
          // → Auto-résoudre les pending existants et passer au thread suivant
          if (hostRepliedAfter || lastGuestIdx === -1) {
            if (existingPending.length > 0) {
              const now = new Date().toISOString();
              for (const ep of existingPending) {
                await sbPatch('messages', `id=eq.${encodeURIComponent(ep.id)}`, {
                  statut:     'resolved',
                  updated_at: now,
                });
              }
              resolved += existingPending.length;
              console.log('[sync] auto-resolved', existingPending.length, 'pending — booking:', bookingId,
                hostRepliedAfter ? '(host replied)' : '(no guest msg)');
            }
            skipped++;
            continue;
          }

          const lastMsg         = allMessages[lastGuestIdx];
          const messageContent  = extractMessageText(lastMsg);
          const smoobuMessageId = extractSmoobuMessageId(lastMsg);
          const _tr             = buildGuestTranscript(allMessages);
          const _conv           = _tr.multi ? _tr.text : null; // contexte IA multi-messages
          const resaCtx         = await getResaContext(bookingId);
          const trivial         = isTrivialMessage(messageContent);
          const resaConfirmed   = !!(resaCtx.id);
          const daysCheckin     = daysUntilCheckin(resaCtx.checkin || '');

          // ── Cas B : un pending existe déjà pour ce booking
          if (existingPending.length > 0) {
            const mostRecent = existingPending[0]; // premier = plus récent (tri desc)

            // Même message ET pas stale → rien à faire
            if (isSameMessage(mostRecent, smoobuMessageId, messageContent) && !mostRecent.is_stale) {
              skipped++;
              continue;
            }

            // Même message MAIS record stale → auto-expire 48h ou re-générer le brouillon
            if (isSameMessage(mostRecent, smoobuMessageId, messageContent) && mostRecent.is_stale) {
              // Layer 2 : si le record stale a plus de 48h → auto-résoudre (conversation traitée entre temps)
              const STALE_MAX_AGE_MS = 48 * 3600 * 1000;
              const staleSince = mostRecent.updated_at
                ? Date.now() - new Date(mostRecent.updated_at).getTime()
                : Infinity;
              if (staleSince > STALE_MAX_AGE_MS) {
                const now = new Date().toISOString();
                await sbPatch('messages', `id=eq.${encodeURIComponent(mostRecent.id)}`, {
                  statut:     'resolved',
                  updated_at: now,
                });
                resolved++;
                console.log('[sync] stale 48h auto-expire → resolved — booking:', bookingId,
                  '| age:', Math.round(staleSince / 3600000), 'h');
                continue;
              }

              if (!trivial && CLAUDE_KEY && aiUsed < MAX_AI_PER_SYNC) {
                const now = new Date().toISOString();
                let freshAnalysis = { detected_language: null, client_summary_fr: null, classification: null, ai_draft: null, ai_draft_fr: null };
                try {
                  freshAnalysis = await generateFullAnalysis({
                    appart:                 resaCtx?.appart   || appart,
                    voyageur:               resaCtx?.voyageur || guestName,
                    checkin:                resaCtx?.checkin  || '',
                    checkout:               resaCtx?.checkout || '',
                    source:                 resaCtx?.source   || '',
                    message_content:        messageContent,
                    conversation:           _conv,
                  apartment_kb:           await getApartmentKB(resaCtx && resaCtx.appart ? resaCtx.appart : appart),
                  adults:                 resaCtx ? resaCtx.adults : null,
                  children:               resaCtx ? resaCtx.children : null,
                    reservation_confirmed:  !!(resaCtx?.id),
                    days_until_checkin_ctx: daysUntilCheckin(resaCtx?.checkin || ''),
                  });
                  aiUsed++;
                } catch (claudeErr) {
                  console.error('[sync] Claude error (stale regen) booking', bookingId, ':', claudeErr.message);
                  freshAnalysis.ai_draft = '— Génération IA échouée — cliquez Regénérer pour réessayer. —';
                }
                await sbPatch('messages', `id=eq.${encodeURIComponent(mostRecent.id)}`, {
                  detected_language: freshAnalysis.detected_language || null,
                  client_summary_fr: freshAnalysis.client_summary_fr || null,
                  classification:    freshAnalysis.classification    || null,
                  ai_draft:          freshAnalysis.ai_draft          || null,
                  ai_draft_fr:       freshAnalysis.ai_draft_fr       || null,
                  is_stale:          false,
                  updated_at:        now,
                });
                console.log('[sync] stale AUTO-REGEN OK — booking:', bookingId, '| lang:', freshAnalysis.detected_language);
                processed++;
              } else {
                // Trivial stale → ignorer directement
                if (trivial) {
                  const now = new Date().toISOString();
                  await sbPatch('messages', `id=eq.${encodeURIComponent(mostRecent.id)}`, {
                    classification: 'no_reply_needed',
                    statut:         'ignored',
                    ai_draft:       null,
                    ai_draft_fr:    null,
                    is_stale:       false,
                    updated_at:     now,
                  });
                  console.log('[sync] stale trivial → ignored — booking:', bookingId);
                  processed++;
                } else {
                  // Cap IA — laisser stale pour l'instant
                  skipped++;
                }
              }
              continue;
            }

            // Conversation évoluée : nouveau message guest → mise à jour du record existant
            console.log('[sync] conversation évoluée — booking:', bookingId, '| update pending:', mostRecent.id);
            const now = new Date().toISOString();

            if (trivial) {
              await sbPatch('messages', `id=eq.${encodeURIComponent(mostRecent.id)}`, {
                message_content:   messageContent,
                smoobu_message_id: smoobuMessageId  || null,
                classification:    'no_reply_needed',
                statut:            'ignored',
                ai_draft:          null,
                ai_draft_fr:       null,
                client_summary_fr: null,
                is_stale:          false,
                updated_at:        now,
              });
              console.log('[sync] UPDATE trivial → ignored — booking:', bookingId);
            } else if (CLAUDE_KEY && aiUsed < MAX_AI_PER_SYNC) {
              let newAnalysis = { detected_language: null, client_summary_fr: null, classification: null, ai_draft: null, ai_draft_fr: null };
              try {
                newAnalysis = await generateFullAnalysis({
                  appart:                 resaCtx.appart   || appart,
                  voyageur:               resaCtx.voyageur || guestName,
                  checkin:                resaCtx.checkin  || '',
                  checkout:               resaCtx.checkout || '',
                  source:                 resaCtx.source   || '',
                  message_content:        messageContent,
                  conversation:           _conv,
                  apartment_kb:           await getApartmentKB(resaCtx && resaCtx.appart ? resaCtx.appart : appart),
                  adults:                 resaCtx ? resaCtx.adults : null,
                  children:               resaCtx ? resaCtx.children : null,
                  reservation_confirmed:  resaConfirmed,
                  days_until_checkin_ctx: daysCheckin,
                });
                aiUsed++;
              } catch (claudeErr) {
                console.error('[sync] Claude error (update) booking', bookingId, ':', claudeErr.message);
                newAnalysis.ai_draft = '— Génération IA échouée — cliquez Regénérer pour réessayer. —';
              }
              await sbPatch('messages', `id=eq.${encodeURIComponent(mostRecent.id)}`, {
                message_content:   messageContent,
                smoobu_message_id: smoobuMessageId              || null,
                detected_language: newAnalysis.detected_language || null,
                client_summary_fr: newAnalysis.client_summary_fr || null,
                classification:    newAnalysis.classification    || null,
                ai_draft:          newAnalysis.ai_draft          || null,
                ai_draft_fr:       newAnalysis.ai_draft_fr       || null,
                ...(newAnalysis.classification === 'no_reply_needed' ? { statut: 'ignored' } : {}),
                is_stale:          false,
                updated_at:        now,
              });
              console.log('[sync] UPDATE + nouveau brouillon — booking:', bookingId, '| lang:', newAnalysis.detected_language);
            } else {
              // Cap IA atteint : mettre à jour le message mais marquer stale (brouillon effacé)
              await sbPatch('messages', `id=eq.${encodeURIComponent(mostRecent.id)}`, {
                message_content:   messageContent,
                smoobu_message_id: smoobuMessageId || null,
                ai_draft:          null,
                ai_draft_fr:       null,
                is_stale:          true,
                updated_at:        now,
              });
              console.log('[sync] UPDATE stale (cap IA) — booking:', bookingId);
            }
            processed++;
            continue;
          }

          // ── Cas C : aucun pending existant → INSERT nouveau record
          const isDup = await checkDuplicate(bookingId, messageContent, smoobuMessageId);
          if (isDup) { skipped++; continue; }

          let analysis = {
            detected_language: null,
            client_summary_fr: null,
            classification:    trivial ? 'no_reply_needed' : null,
            ai_draft:          null,
            ai_draft_fr:       null,
          };
          if (!trivial) {
            if (CLAUDE_KEY && aiUsed < MAX_AI_PER_SYNC) {
              try {
                analysis = await generateFullAnalysis({
                  appart:                 resaCtx.appart   || appart,
                  voyageur:               resaCtx.voyageur || guestName,
                  checkin:                resaCtx.checkin  || '',
                  checkout:               resaCtx.checkout || '',
                  source:                 resaCtx.source   || '',
                  message_content:        messageContent,
                  conversation:           _conv,
                  apartment_kb:           await getApartmentKB(resaCtx && resaCtx.appart ? resaCtx.appart : appart),
                  adults:                 resaCtx ? resaCtx.adults : null,
                  children:               resaCtx ? resaCtx.children : null,
                  reservation_confirmed:  resaConfirmed,
                  days_until_checkin_ctx: daysCheckin,
                });
                aiUsed++;
              } catch (claudeErr) {
                console.error('[sync] Claude error booking', bookingId, ':', claudeErr.message);
                analysis.ai_draft = '— Génération IA échouée — cliquez Regénérer pour réessayer. —';
              }
            } else if (aiUsed >= MAX_AI_PER_SYNC) {
              console.log('[sync] cap IA atteint — booking', bookingId, 'inséré sans brouillon');
            }
          } else {
            console.log('[sync] message trivial — booking:', bookingId, '| no_reply_needed');
          }

          const now = new Date().toISOString();
          // no_reply_needed (regex triviale OU classification Claude) → archivé d'office :
          // aucune action requise, ne doit pas occuper la liste pending
          const noReplySync = trivial || analysis.classification === 'no_reply_needed';
          await sbInsert('messages', {
            id:                uid(),
            smoobu_booking_id: bookingId,
            reservation_id:    resaCtx.id              || null,
            appart:            resaCtx.appart || appart || null,
            voyageur:          resaCtx.voyageur || guestName || null,
            source:            resaCtx.source          || null,
            sender:            'guest',
            message_content:   messageContent,
            detected_language: analysis.detected_language || null,
            client_summary_fr: analysis.client_summary_fr || null,
            classification:    analysis.classification    || null,
            ai_draft:          analysis.ai_draft          || null,
            ai_draft_fr:       analysis.ai_draft_fr       || null,
            smoobu_message_id: smoobuMessageId            || null,
            is_stale:          false,
            raw_payload:       { booking_id: bookingId, thread },
            statut:            noReplySync ? 'ignored' : 'pending',
            created_at:        now,
            updated_at:        now,
          });

          console.log('[sync] INSERT OK — booking:', bookingId, '| voyageur:', guestName, '| lang:', analysis.detected_language);
          processed++;

        } catch (threadErr) {
          if (threadErr.message.includes('23505') || threadErr.message.toLowerCase().includes('unique')) {
            skipped++;
          } else {
            console.error('[sync] erreur booking', bookingId, ':', threadErr.message);
            errors++;
          }
        }
      }

      console.log('[sync] threads terminé — processed:', processed, '| skipped:', skipped, '| resolved:', resolved, '| errors:', errors, '| ai_calls:', aiUsed);

      // ── 4. Scan Booking.com direct ────────────────────────────
      // Booking.com ne remonte pas automatiquement dans GET /api/threads.
      // Smoobu importe les messages Booking.com seulement à la demande
      // (visite de la page réservation dans l'interface, ou appel API direct).
      // On interroge donc GET /api/reservations/{id}/messages sur chaque
      // réservation Booking.com récente connue dans la table resa.
      // IDs déjà traités via threads → ignorés (évite doublons)
      const processedViaThreads = new Set(recentThreads.map(function(t) { return String(t.booking?.id); }));
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      let bookingResaList = [];
      try {
        bookingResaList = await sbGet(
          `resa?source=eq.Booking.com&smoobu_id=not.is.null&checkout=gte.${fourteenDaysAgo}` +
          `&select=smoobu_id,appart,voyageur,source,checkin,checkout,id&order=checkout.desc&limit=30`
        ) || [];
      } catch (resaErr) {
        console.warn('[sync] Booking.com resa query failed:', resaErr.message);
      }

      let bcom_processed = 0, bcom_skipped = 0, bcom_resolved = 0, bcom_errors = 0;

      for (const resa of bookingResaList) {
        const bookingId = parseInt(String(resa.smoobu_id), 10);
        if (!bookingId || isNaN(bookingId)) { bcom_skipped++; continue; }
        // Déjà traité via threads ? (peu probable pour Booking.com mais prudence)
        if (processedViaThreads.has(String(bookingId))) { bcom_skipped++; continue; }

        try {
          const msgData     = await getSmoobuMessages(bookingId);
          const rawMessages = msgData?.messages || msgData?.data || (Array.isArray(msgData) ? msgData : []);
          const allMessages = sortMessagesChronologically(rawMessages);

          if (!allMessages.length) { bcom_skipped++; continue; }

          const { lastGuestIdx, hostRepliedAfter } = analyzeConversation(allMessages);
          const existingPending = pendingByBooking[String(bookingId)] || [];

          // Cas A : hôte a répondu ou pas de message voyageur → auto-résoudre
          if (hostRepliedAfter || lastGuestIdx === -1) {
            if (existingPending.length > 0) {
              const now = new Date().toISOString();
              for (const ep of existingPending) {
                await sbPatch('messages', `id=eq.${encodeURIComponent(ep.id)}`, { statut: 'resolved', updated_at: now });
              }
              bcom_resolved += existingPending.length;
              console.log('[sync] Booking.com auto-resolved', existingPending.length, '— booking:', bookingId);
            }
            bcom_skipped++;
            continue;
          }

          const lastMsg        = allMessages[lastGuestIdx];
          const messageContent = extractMessageText(lastMsg);
          const smoobuMsgId    = extractSmoobuMessageId(lastMsg);
          if (!messageContent) { bcom_skipped++; continue; }
          const _trBc   = buildGuestTranscript(allMessages);
          const _convBc = _trBc.multi ? _trBc.text : null; // contexte IA multi-messages

          // Cas B : pending existant, même message → skip (pas de stale pour scan direct)
          if (existingPending.length > 0 && isSameMessage(existingPending[0], smoobuMsgId, messageContent)) {
            bcom_skipped++;
            continue;
          }

          // Cas C : vérif doublons puis INSERT
          const isDupBc = await checkDuplicate(bookingId, messageContent, smoobuMsgId);
          if (isDupBc) { bcom_skipped++; continue; }

          const trivialBc = isTrivialMessage(messageContent);
          let analysisBc = {
            detected_language: null, client_summary_fr: null,
            classification:    trivialBc ? 'no_reply_needed' : null,
            ai_draft:          null, ai_draft_fr: null,
          };
          if (!trivialBc && CLAUDE_KEY && aiUsed < MAX_AI_PER_SYNC) {
            try {
              analysisBc = await generateFullAnalysis({
                appart:                 resa.appart   || '',
                voyageur:               resa.voyageur || '',
                checkin:                resa.checkin  || '',
                checkout:               resa.checkout || '',
                source:                 'Booking.com',
                message_content:        messageContent,
                conversation:           _convBc,
                apartment_kb:           await getApartmentKB(resa && resa.appart ? resa.appart : ''),
                reservation_confirmed:  true,
                days_until_checkin_ctx: daysUntilCheckin(resa.checkin || ''),
              });
              aiUsed++;
            } catch (claudeErr) {
              console.error('[sync] Claude error Booking.com', bookingId, ':', claudeErr.message);
              analysisBc.ai_draft = '— Génération IA échouée — cliquez Regénérer pour réessayer. —';
            }
          } else if (!trivialBc && aiUsed >= MAX_AI_PER_SYNC) {
            console.log('[sync] Booking.com cap IA — booking:', bookingId, '| inséré sans brouillon');
          }

          const now = new Date().toISOString();
          await sbInsert('messages', {
            id:                uid(),
            smoobu_booking_id: bookingId,
            reservation_id:    resa.id              || null,
            appart:            resa.appart          || null,
            voyageur:          resa.voyageur        || null,
            source:            'Booking.com',
            sender:            'guest',
            message_content:   messageContent,
            detected_language: analysisBc.detected_language || null,
            client_summary_fr: analysisBc.client_summary_fr || null,
            classification:    analysisBc.classification    || null,
            ai_draft:          analysisBc.ai_draft          || null,
            ai_draft_fr:       analysisBc.ai_draft_fr       || null,
            smoobu_message_id: smoobuMsgId                  || null,
            is_stale:          false,
            raw_payload:       { booking_id: bookingId, source: 'booking_com_direct_scan' },
            statut:            trivialBc ? 'ignored' : 'pending',
            created_at:        now,
            updated_at:        now,
          });
          console.log('[sync] Booking.com INSERT — booking:', bookingId, '| voyageur:', resa.voyageur, '| lang:', analysisBc.detected_language);
          bcom_processed++;

        } catch (bcErr) {
          if (bcErr.message.includes('23505') || bcErr.message.toLowerCase().includes('unique')) {
            bcom_skipped++;
          } else {
            console.error('[sync] Booking.com resa', bookingId, ':', bcErr.message);
            bcom_errors++;
          }
        }
      }

      if (bcom_processed + bcom_resolved + bcom_errors > 0 || bookingResaList.length > 0) {
        console.log('[sync] Booking.com direct —', bcom_processed, 'insérés |', bcom_resolved, 'résolus |',
          bcom_skipped, 'skipped |', bcom_errors, 'erreurs | resas_vérifiées:', bookingResaList.length);
      }

      const totalProcessed = processed + bcom_processed;
      const totalResolved  = resolved  + bcom_resolved;
      const totalErrors    = errors    + bcom_errors;

      return res.status(200).json({
        ok: true, sync: true, hoursBack,
        threads_checked: recentThreads.length,
        processed: totalProcessed, skipped, resolved: totalResolved, errors: totalErrors,
        ai_calls:  aiUsed,
        booking_com: {
          resas_checked: bookingResaList.length,
          processed:     bcom_processed,
          resolved:      bcom_resolved,
          skipped:       bcom_skipped,
          errors:        bcom_errors,
        },
      });

    } catch (syncErr) {
      console.error('[sync] erreur globale:', syncErr.message);
      return res.status(500).json({ error: syncErr.message });
    }
  }

  // ── Historique des envois : GET ?sentHistory=1 ────────────
  // Retourne les messages envoyés depuis le CRM sur les dernières 24h
  // (ou ?sentHours=N pour une fenêtre différente, max 168h)
  // Aucun appel Claude — lecture DB pure
  if (req.method === 'GET' && req.query?.sentHistory) {
    try {
      const hours = Math.min(parseInt(req.query.sentHours || '24', 10) || 24, 168);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const rows  = await sbGet(
        `messages?statut=eq.sent&sent_at=gte.${encodeURIComponent(since)}` +
        `&select=id,smoobu_booking_id,voyageur,appart,source,classification,` +
        `ai_draft,sent_at,smoobu_api_response,updated_at,error_message` +
        `&order=sent_at.desc&limit=100`
      );
      const sent = (rows || []).map(function(r) {
        let apiResp = null;
        try { apiResp = r.smoobu_api_response ? JSON.parse(r.smoobu_api_response) : null; } catch {}
        const smoobuMsgId = apiResp?.id ?? apiResp?.data?.id ?? null;
        return {
          id:             r.id,
          booking_id:     r.smoobu_booking_id,
          voyageur:       r.voyageur,
          appart:         r.appart,
          source:         r.source,
          classification: r.classification,
          sent_text:      r.ai_draft,
          sent_at:        r.sent_at,
          smoobu_msg_id:  smoobuMsgId,
          smoobu_confirmed: smoobuMsgId !== null,
          smoobu_raw:     apiResp,
          error:          r.error_message || null,
        };
      });
      return res.status(200).json({ ok: true, hours, count: sent.length, sent });
    } catch (err) {
      console.error('[sentHistory] erreur:', err.message);
      return res.status(500).json({ error: err.message });
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
        `messages?id=eq.${encodeURIComponent(message_id)}&select=id,smoobu_booking_id,message_content,appart,voyageur,source,statut,reservation_id&limit=1`
      );
      const msg = rows?.[0];
      if (!msg) return res.status(404).json({ error: 'Message introuvable' });
      if (msg.statut === 'sent') return res.status(409).json({ error: 'Message déjà envoyé — impossible de regénérer' });

      // Récupérer checkin/checkout depuis resa via smoobu_booking_id
      const resaCtx = await getResaContext(msg.smoobu_booking_id);

      // ── Re-fetch Smoobu pour avoir le dernier état réel de la conversation ──
      // Si la conversation a évolué depuis la dernière capture, on utilise le
      // dernier message voyageur actuel, pas celui figé en DB.
      let latestContent    = msg.message_content;
      let latestMsgId      = null;
      let contentUpdated   = false;
      try {
        const freshData  = await getSmoobuMessages(msg.smoobu_booking_id);
        const freshRaw   = freshData?.messages || freshData?.data || (Array.isArray(freshData) ? freshData : []);
        const freshMsgs  = sortMessagesChronologically(freshRaw); // trier ASC
        let freshLastIdx = -1;
        for (let gi = freshMsgs.length - 1; gi >= 0; gi--) {
          if (isGuestMessage(freshMsgs[gi]) && extractMessageText(freshMsgs[gi]).length > 0) {
            freshLastIdx = gi;
            break;
          }
        }
        if (freshLastIdx !== -1) {
          const fc = extractMessageText(freshMsgs[freshLastIdx]);
          if (fc) {
            latestMsgId    = extractSmoobuMessageId(freshMsgs[freshLastIdx]);
            contentUpdated = fc.trim() !== (msg.message_content || '').trim();
            latestContent  = fc;
            if (contentUpdated) {
              console.log('[regenerate] contenu mis à jour depuis Smoobu — booking:', msg.smoobu_booking_id,
                '| ancien:', String(msg.message_content).slice(0, 60),
                '| nouveau:', fc.slice(0, 60));
            }
          }
        }
      } catch (smoobuErr) {
        console.warn('[regenerate] Smoobu fetch échoué — utilisation du contenu en DB:', smoobuErr.message);
      }

      const _regenAppart = msg.appart || resaCtx.appart || '';
      const analysis = await generateFullAnalysis({
        appart:                 _regenAppart,
        voyageur:               msg.voyageur || resaCtx.voyageur || '',
        checkin:                resaCtx.checkin  || '',
        checkout:               resaCtx.checkout || '',
        source:                 msg.source   || resaCtx.source   || '',
        message_content:        latestContent,
        hakim_instruction:      String(hakim_instruction).trim(),
        reservation_confirmed:  !!(msg.reservation_id || resaCtx.id),
        days_until_checkin_ctx: daysUntilCheckin(resaCtx.checkin || ''),
        // FIX : le chemin Régénérer n'injectait NI la fiche logement (→ lien Google
        // Maps/wifi absents quand Hakim régénère), NI le style, NI la composition.
        apartment_kb:           await getApartmentKB(_regenAppart),
        style_examples:         await getHakimStyleExamples(6),
        adults:                 resaCtx.adults   != null ? resaCtx.adults   : null,
        children:               resaCtx.children != null ? resaCtx.children : null,
      });

      const now = new Date().toISOString();
      await sbPatch('messages', `id=eq.${encodeURIComponent(message_id)}`, {
        ai_draft:          analysis.ai_draft    || null,
        ai_draft_fr:       analysis.ai_draft_fr || null,
        classification:    analysis.classification || null,
        hakim_instruction: String(hakim_instruction).trim(),
        is_stale:          false,
        updated_at:        now,
        // Si le message a évolué depuis Smoobu, mettre à jour le contenu en DB
        ...(contentUpdated ? {
          message_content:   latestContent,
          smoobu_message_id: latestMsgId || null,
        } : {}),
      });

      console.log('[messages] regenerate OK — message_id:', message_id, '| instruction:', String(hakim_instruction).slice(0, 60), '| content_updated:', contentUpdated);
      return res.status(200).json({
        ok:                      true,
        ai_draft:                analysis.ai_draft    || '',
        ai_draft_fr:             analysis.ai_draft_fr || '',
        message_content_updated: contentUpdated ? latestContent : null,
      });

    } catch (err) {
      console.error('[messages] regenerate error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Reformuler un brouillon de Hakim : POST ?reword=1 ────────
  // Polit le texte écrit par l'hôte (orthographe + ton pro) sans changer le sens.
  // Aucune écriture en base, aucun envoi.
  if (req.query?.reword) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { text, source, appart } = body || {};
      if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' });
      if (!CLAUDE_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée' });
      const styleEx = await getHakimStyleExamples(5);
      const reworded = await rewordReply(String(text).trim(), { source: source || '', appart: appart || '', styleExamples: styleEx });
      return res.status(200).json({ ok: true, text: reworded });
    } catch (err) {
      console.error('[reword] erreur:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Assistant : POST ?assist=1 (mode=refine | advise) ────────
  // refine : révise le brouillon selon une consigne de Hakim (+ style appris).
  // advise : relit le brouillon et conseille SANS réécrire. Aucune écriture base.
  if (req.query?.assist) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { mode, draft, instruction, client_context, source, appart, checkin, checkout, adults, children } = body || {};
      if (!draft || !String(draft).trim()) return res.status(400).json({ error: 'draft requis' });
      if (!CLAUDE_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée' });
      const m = (mode === 'advise') ? 'advise' : 'refine';
      const styleEx = (m === 'refine') ? await getHakimStyleExamples(5) : [];
      const out = await assistReply(m, {
        draft:         String(draft).trim(),
        instruction:   String(instruction || '').trim(),
        clientContext: String(client_context || '').trim(),
        source:        source || '', appart: appart || '',
        checkin:       String(checkin || '').trim(),
        checkout:      String(checkout || '').trim(),
        adults:        (adults != null && adults !== '') ? parseInt(adults, 10) : null,
        children:      (children != null && children !== '') ? parseInt(children, 10) : null,
        styleExamples: styleEx,
        apartmentKb:   (m === 'refine') ? await getApartmentKB(String(appart || '').trim()) : null,
      });
      return res.status(200).json({ ok: true, mode: m, text: out });
    } catch (err) {
      console.error('[assist] erreur:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Traduction (messagerie style Airbnb) : POST ?translate=1 ─
  // { texts:[...] } -> traduit le lot vers le français + détecte la langue source.
  // { text:"...", to:"anglais" } -> traduit le texte de Hakim vers la langue du client.
  if (req.query?.translate) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!CLAUDE_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée' });
      if (Array.isArray(body?.texts)) {
        const r = await translateBatchToFrench(body.texts);
        return res.status(200).json({ ok: true, detected: r.detected, translations: r.translations });
      }
      if (body?.text) {
        const out = await translateToLang(String(body.text), String(body.to || ''));
        return res.status(200).json({ ok: true, text: out });
      }
      return res.status(400).json({ error: 'texts[] ou text requis' });
    } catch (err) {
      console.error('[translate] erreur:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Brouillon IA manuel : POST ?manualDraft=1 ────────────────
  // Génère un brouillon sans lien à une réservation Smoobu existante.
  // Usage : WhatsApp, Booking.com hors Smoobu, prospects, etc.
  // Aucune écriture en base — aucun envoi automatique.
  if (req.query?.manualDraft) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { message, conversation, source, appart, voyageur, instruction, checkin, checkout, adults, children, reservation_confirmed } = body || {};

      const hasMsg   = message     && String(message).trim();
      const hasInstr = instruction && String(instruction).trim();
      // On accepte un message reçu OU une simple consigne (message proactif que l'hôte
      // veut écrire lui-même, sans message client à analyser).
      if (!hasMsg && !hasInstr) {
        return res.status(400).json({ error: 'message ou instruction requis' });
      }
      if (!CLAUDE_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée' });
      }

      const analysis = await generateFullAnalysis({
        appart:                 String(appart      || '').trim(),
        voyageur:               String(voyageur    || '').trim(),
        checkin:                String(checkin  || '').trim(),
        checkout:               String(checkout || '').trim(),
        source:                 String(source      || '').trim(),
        message_content:        hasMsg ? String(message).trim()
                                       : '[Aucun message reçu du client. Rédige le message que l\'hôte souhaite ENVOYER au client, en appliquant exactement la consigne ci-dessous.]',
        conversation:           String(conversation || '').trim() || undefined,
        hakim_instruction:      String(instruction || '').trim() || undefined,
        reservation_confirmed:  (typeof reservation_confirmed === 'boolean') ? reservation_confirmed : !!(checkin),
        days_until_checkin_ctx: daysUntilCheckin(String(checkin || '').trim()),
        adults:                 (adults != null && adults !== '') ? parseInt(adults, 10) : null,
        children:               (children != null && children !== '') ? parseInt(children, 10) : null,
        style_examples:         await getHakimStyleExamples(5),
        apartment_kb:           await getApartmentKB(String(appart || '').trim()),
      });

      console.log('[manualDraft] OK | lang:', analysis.detected_language, '| classif:', analysis.classification, '| source:', source || '–');
      return res.status(200).json({
        ok:                true,
        classification:    analysis.classification,
        detected_language: analysis.detected_language,
        client_summary_fr: analysis.client_summary_fr,
        ai_draft:          analysis.ai_draft    || '',
        ai_draft_fr:       analysis.ai_draft_fr || '',
      });

    } catch (err) {
      console.error('[manualDraft] erreur:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Lecture d'une PHOTO (Claude Vision) : POST ?analyzeImage=1 ─
  // Décrit l'image en français + propose un brouillon. Aucune écriture en base.
  if (req.query?.analyzeImage) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { image_base64, media_type, message, source, appart, instruction, checkin, checkout, adults, children } = body || {};

      if (!image_base64 || !String(image_base64).trim()) {
        return res.status(400).json({ error: 'image requise' });
      }
      if (!CLAUDE_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée' });
      }
      const mt = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(media_type) ? media_type : 'image/jpeg';

      const analysis = await analyzeImageMessage({
        appart:            String(appart || '').trim(),
        source:            String(source || '').trim(),
        message_content:   String(message || '').trim(),
        hakim_instruction: String(instruction || '').trim() || undefined,
        image_base64:      String(image_base64),
        media_type:        mt,
        checkin:           String(checkin  || '').trim(),
        checkout:          String(checkout || '').trim(),
        adults:            (adults != null && adults !== '') ? parseInt(adults, 10) : null,
        children:          (children != null && children !== '') ? parseInt(children, 10) : null,
        style_examples:    await getHakimStyleExamples(5),
        apartment_kb:      await getApartmentKB(String(appart || '').trim()),
      });

      console.log('[analyzeImage] OK | classif:', analysis.classification, '| lang:', analysis.detected_language);
      return res.status(200).json({
        ok:                true,
        description_fr:    analysis.description_fr,
        classification:    analysis.classification,
        detected_language: analysis.detected_language,
        ai_draft:          analysis.ai_draft    || '',
        ai_draft_fr:       analysis.ai_draft_fr || '',
      });

    } catch (err) {
      console.error('[analyzeImage] erreur:', err.message);
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

      const smoobuResult = await sendSmoobuMessage(msg.smoobu_booking_id, String(text).trim());

      // Smoobu doit confirmer avec un id dans la réponse.
      // Si confirmed=false → Smoobu a répondu 200 mais sans id → statut error, pas sent.
      const confirmed    = smoobuResult.confirmed;
      const now          = new Date().toISOString();
      const apiRespStr   = JSON.stringify(smoobuResult.body);

      await sbPatch('messages', `id=eq.${encodeURIComponent(message_id)}`, {
        statut:               confirmed ? 'sent'  : 'error',
        ai_draft:             String(text).trim(),
        sent_at:              confirmed ? now     : null,
        updated_at:           now,
        smoobu_api_response:  apiRespStr,
        error_message:        confirmed ? null    : `Smoobu HTTP ${smoobuResult.httpStatus} — réponse sans id: ${apiRespStr}`,
      });

      console.log('[messages] send result — message_id:', message_id,
        '| booking_id:', msg.smoobu_booking_id,
        '| smoobu_http:', smoobuResult.httpStatus,
        '| confirmed:', confirmed,
        '| smoobu_msg_id:', smoobuResult.msgId,
        '| body:', apiRespStr.slice(0, 200));

      if (!confirmed) {
        return res.status(200).json({
          ok:      false,
          sent:    false,
          message_id,
          warning: 'Smoobu a répondu 200 mais sans identifiant de message — vérifiez manuellement dans Smoobu',
          smoobu_http: smoobuResult.httpStatus,
        });
      }
      return res.status(200).json({ ok: true, sent: true, message_id, smoobu_msg_id: smoobuResult.msgId });

    } catch (err) {
      console.error('[messages] send error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Envoi direct vers une réservation : POST ?sendDirect=1 ───
  // Envoie une réponse hôte à un booking (depuis la vue Conversation ou IA Manuelle
  // avec client ciblé) et l'enregistre (statut=sent) → elle apparaît dans le fil.
  // JAMAIS automatique : déclenché par un clic explicite de Hakim côté CRM.
  if (req.query?.sendDirect) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { booking_id, text, voyageur, appart, source } = body || {};
      if (!booking_id || !String(booking_id).trim()) return res.status(400).json({ error: 'booking_id requis' });
      if (!text || !String(text).trim())             return res.status(400).json({ error: 'text requis' });

      const smoobuResult = await sendSmoobuMessage(String(booking_id).trim(), String(text).trim());
      const now = new Date().toISOString();
      // Enregistre la réponse hôte pour qu'elle s'affiche dans la conversation
      try {
        await sbInsert('messages', {
          id:                  uid(),
          smoobu_booking_id:   String(booking_id).trim(),
          sender:              'host',
          message_content:     '(réponse envoyée depuis le CRM)',
          ai_draft:            String(text).trim(),
          voyageur:            voyageur || null,
          appart:              appart   || null,
          source:              source   || null,
          statut:              'sent',
          sent_at:             now,
          smoobu_api_response: JSON.stringify(smoobuResult.body),
          created_at:          now,
          updated_at:          now,
        });
      } catch (insErr) { console.warn('[messages] sendDirect: insert record échoué:', insErr.message); }

      console.log('[messages] sendDirect OK — booking:', booking_id, '| http:', smoobuResult.httpStatus);
      return res.status(200).json({ ok: true, sent: true, booking_id, smoobu_http: smoobuResult.httpStatus });
    } catch (err) {
      console.error('[messages] sendDirect error:', err.message);
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
    const rawMessagesWh = (
      msgData?.messages ||
      msgData?.data     ||
      (Array.isArray(msgData) ? msgData : [])
    );
    // Trier chronologiquement ASC (Smoobu peut retourner DESC)
    const allMessages = sortMessagesChronologically(rawMessagesWh);

    console.log('[messages] nb_msgs:', allMessages.length, '| booking:', booking.id);

    // Trouver l'index du DERNIER message voyageur avec contenu (ordre chrono ASC garanti)
    let lastGuestIdxWh = -1;
    for (let gi = allMessages.length - 1; gi >= 0; gi--) {
      if (isGuestMessage(allMessages[gi]) && extractMessageText(allMessages[gi]).length > 0) {
        lastGuestIdxWh = gi;
        break;
      }
    }
    if (lastGuestIdxWh === -1) {
      console.log('[messages] Aucun message voyageur — booking:', booking.id);
      return res.status(200).json({ ok: true, skipped: 'no_guest_message' });
    }

    // Vérifier si l'hôte a déjà répondu APRÈS le dernier message voyageur
    // Cas typique : webhook déclenché par la réponse de l'hôte lui-même
    const hostRepliedAfterWh = allMessages.slice(lastGuestIdxWh + 1).some(function(m) {
      return !isGuestMessage(m) && extractMessageText(m).length > 0;
    });
    if (hostRepliedAfterWh) {
      console.log('[messages] hôte a déjà répondu après voyageur — booking:', booking.id, '| skip');
      // Auto-resolve si un pending existe
      try {
        const epWh = await sbGet(
          `messages?smoobu_booking_id=eq.${booking.id}&statut=eq.pending&select=id&order=created_at.desc&limit=5`
        );
        if (epWh?.length) {
          const nowWh = new Date().toISOString();
          for (const ep of epWh) {
            await sbPatch('messages', `id=eq.${encodeURIComponent(ep.id)}`, { statut: 'resolved', updated_at: nowWh });
          }
          console.log('[messages] webhook auto-resolved', epWh.length, 'pending — booking:', booking.id);
        }
      } catch (resolveErr) {
        console.warn('[messages] webhook auto-resolve failed:', resolveErr.message);
      }
      return res.status(200).json({ ok: true, skipped: 'host_already_replied' });
    }

    const lastMsg = allMessages[lastGuestIdxWh];

    const messageContent  = extractMessageText(lastMsg);
    const smoobuMessageId = extractSmoobuMessageId(lastMsg);

    if (!messageContent) {
      return res.status(200).json({ ok: true, skipped: 'empty_message' });
    }

    // Transcript des derniers messages voyageur (le client écrit souvent en plusieurs
    // messages successifs) → l'IA répond à L'ENSEMBLE, pas au dernier fragment seul.
    const whTr = buildGuestTranscript(allMessages);
    const conversationText = whTr.text;
    const isMultiPart = whTr.multi;
    // Ce qu'on stocke/affiche : le fil complet si multi-messages, sinon le message seul
    const displayContent = isMultiPart ? conversationText : messageContent;

    // 2. Déduplication (même message déjà en base)
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
    const appart   = resaCtx.appart   || booking.apartment?.name || '';
    const source   = resaCtx.source   || '';
    const checkin  = resaCtx.checkin  || booking.arrivalDate   || '';
    const checkout = resaCtx.checkout || booking.departureDate || '';
    const resaConfirmedWh   = !!(resaCtx.id);
    const daysCheckinWh     = daysUntilCheckin(checkin);

    // 3b. Chercher un pending existant pour ce booking (conversation peut avoir évolué)
    let existingPendingIdWh = null;
    try {
      const epRows = await sbGet(
        `messages?smoobu_booking_id=eq.${booking.id}&statut=eq.pending&select=id&order=created_at.desc&limit=1`
      );
      existingPendingIdWh = epRows?.[0]?.id || null;
    } catch { /* ignore — on insère normalement si échec */ }

    // 4. Vérification message trivial + Analyse IA via Claude
    const trivialWh = isTrivialMessage(messageContent);
    let analysis = {
      detected_language: null,
      client_summary_fr: null,
      classification:    trivialWh ? 'no_reply_needed' : null,
      ai_draft:          null,
      ai_draft_fr:       null,
    };
    if (!trivialWh && CLAUDE_KEY) {
      try {
        analysis = await generateFullAnalysis({
          appart, voyageur: guestName, checkin, checkout, source,
          message_content:        messageContent,
          conversation:           isMultiPart ? conversationText : null,
          reservation_confirmed:  resaConfirmedWh,
          days_until_checkin_ctx: daysCheckinWh,
          adults:                 resaCtx.adults,
          children:               resaCtx.children,
          apartment_kb:           await getApartmentKB(appart),
          style_examples:         await getHakimStyleExamples(5),
        });
        console.log('[messages] Claude OK — lang:', analysis.detected_language, '| classif:', analysis.classification);
      } catch (claudeErr) {
        console.error('[messages] Claude error:', claudeErr.message);
        analysis.ai_draft = '— Génération automatique échouée. Rédigez votre réponse ci-dessous. —';
      }
    } else if (trivialWh) {
      console.log('[messages] message trivial webhook — booking:', booking.id, '| no_reply_needed, Claude ignoré');
    } else {
      console.warn('[messages] ANTHROPIC_API_KEY non configurée — analyse IA ignorée');
    }

    // 5. UPDATE le pending existant ou INSERT nouveau record
    const now = new Date().toISOString();

    if (existingPendingIdWh) {
      // Conversation évoluée : mettre à jour le pending existant au lieu de dupliquer
      await sbPatch('messages', `id=eq.${encodeURIComponent(existingPendingIdWh)}`, {
        message_content:   displayContent,
        smoobu_message_id: smoobuMessageId              || null,
        detected_language: analysis.detected_language   || null,
        client_summary_fr: analysis.client_summary_fr   || null,
        classification:    analysis.classification      || null,
        ai_draft:          analysis.ai_draft            || null,
        ai_draft_fr:       analysis.ai_draft_fr         || null,
        ...((trivialWh || analysis.classification === 'no_reply_needed') ? { statut: 'ignored' } : {}),
        is_stale:          false,
        updated_at:        now,
      });
      console.log('[messages] UPDATE existing pending — booking:', booking.id, '| id:', existingPendingIdWh, '| lang:', analysis.detected_language);
      return res.status(200).json({ ok: true, action, message_id: existingPendingIdWh, updated: true });
    }

    const newMsg = {
      id:                uid(),
      smoobu_booking_id: booking.id,
      reservation_id:    resaCtx.id          || null,
      appart:            appart              || null,
      voyageur:          guestName           || null,
      source:            source              || null,
      sender:            'guest',
      message_content:   displayContent,
      detected_language: analysis.detected_language || null,
      client_summary_fr: analysis.client_summary_fr || null,
      classification:    analysis.classification    || null,
      ai_draft:          analysis.ai_draft          || null,
      ai_draft_fr:       analysis.ai_draft_fr       || null,
      smoobu_message_id: smoobuMessageId     || null,
      is_stale:          false,
      raw_payload:       booking             || null,
      statut:            (trivialWh || analysis.classification === 'no_reply_needed') ? 'ignored' : 'pending',
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

    // Pas de record « erreur » visible : ces erreurs (404 prospect, transitoires
    // Smoobu/Claude) ne sont pas actionnables par l'hôte et polluaient la liste
    // Messages IA. On loggue côté serveur (Vercel) et on renvoie 500 → Smoobu peut
    // retenter les erreurs réellement transitoires.
    console.error('[messages] erreur traitement (booking ' + booking.id + '):', err.message);
    return res.status(500).json({ error: err.message });
  }
}
