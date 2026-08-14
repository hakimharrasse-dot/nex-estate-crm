// ============================================================
// test-smoobu-onlyRelatedToGuest.mjs — diagnostic messagerie Smoobu
//
// But : vérifier empiriquement si le paramètre suggéré par le support
//       Smoobu (onlyRelatedToGuest=false) fait remonter les réponses de
//       l'hôte (type=2) en plus des messages voyageur (type=1).
//
// Usage (PowerShell, depuis le dossier du projet) :
//   $env:SMOOBU_API_KEY = "TA_CLE_API_SMOOBU"
//   node test-smoobu-onlyRelatedToGuest.mjs 143041602
//
//   (remplace 143041602 par un vrai booking_id où TU as répondu depuis
//    Airbnb/Booking/Smoobu — un fil où tu SAIS qu'il y a des réponses hôte)
//
// La clé API se trouve dans Smoobu : Paramètres → Compte → Api → clé API.
// ============================================================

const API   = 'https://login.smoobu.com/api';
const KEY   = process.env.SMOOBU_API_KEY;
const BOOK  = process.argv[2];

if (!KEY)  { console.error('❌ SMOOBU_API_KEY manquant. Fais : $env:SMOOBU_API_KEY = "..."'); process.exit(1); }
if (!BOOK) { console.error('❌ Booking ID manquant. Fais : node test-smoobu-onlyRelatedToGuest.mjs <booking_id>'); process.exit(1); }

async function fetchMessages(url) {
  const res = await fetch(url, { headers: { 'Api-Key': KEY, 'Content-Type': 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function summarize(label, url, { status, json, text }) {
  console.log('\n────────────────────────────────────────');
  console.log(label);
  console.log('URL :', url);
  console.log('HTTP:', status);
  if (!json) { console.log('Réponse brute (non-JSON) :', text.slice(0, 400)); return { total: 0, byType: {} }; }

  const messages = json.messages || json.data || (Array.isArray(json) ? json : []);
  const byType = {};
  for (const m of messages) {
    const t = (typeof m.type === 'number') ? String(m.type) : String(m.type || m.sender || m.from || 'inconnu');
    byType[t] = (byType[t] || 0) + 1;
  }
  console.log('Total messages :', messages.length);
  console.log('Répartition par type :', JSON.stringify(byType));
  console.log('  (rappel : type 1 = voyageur, type 2 = hôte)');

  // Aperçu des 3 derniers messages
  const tail = messages.slice(-3).map(m => {
    const t = (typeof m.type === 'number') ? m.type : (m.type || m.sender || '?');
    const body = String(m.message || m.htmlMessage || m.content || m.body || m.text || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    return `   [type ${t}] ${body}`;
  });
  if (tail.length) { console.log('3 derniers messages :'); tail.forEach(l => console.log(l)); }

  return { total: messages.length, byType };
}

(async () => {
  const urlSans = `${API}/reservations/${BOOK}/messages`;
  const urlAvec = `${API}/reservations/${BOOK}/messages?onlyRelatedToGuest=false`;

  const sans = summarize('🔵 SANS le paramètre (comportement actuel du CRM)', urlSans, await fetchMessages(urlSans));
  const avec = summarize('🟢 AVEC onlyRelatedToGuest=false (suggestion support)', urlAvec, await fetchMessages(urlAvec));

  console.log('\n════════════════════════════════════════');
  console.log('VERDICT');
  const hostSans = (sans.byType['2'] || 0);
  const hostAvec = (avec.byType['2'] || 0);
  console.log(`Messages hôte (type 2) SANS param : ${hostSans}`);
  console.log(`Messages hôte (type 2) AVEC param : ${hostAvec}`);
  if (avec.total > sans.total || hostAvec > hostSans) {
    console.log('✅ Le paramètre RAMÈNE PLUS de messages → le CRM peut récupérer l\'historique complet.');
    console.log('   → Ajouter onlyRelatedToGuest=false dans getSmoobuMessages().');
  } else {
    console.log('❌ Aucune différence → le paramètre ne change rien sur cet endpoint.');
    console.log('   → Renvoyer ce résultat au support Smoobu (voir message type ci-dessous).');
  }
})();
