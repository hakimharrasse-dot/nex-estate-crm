// ============================================================
// test-smoobu-hmac.mjs — valide la signature HMAC-SHA256 Smoobu
// contre la VRAIE API (la migration accepte déjà les requêtes signées).
// Un HTTP 200 sur une requête signée = la chaîne canonique est correcte.
//
// Usage (PowerShell) :
//   $env:SMOOBU_API_KEY = "..."     (clé API, inchangée)
//   $env:SMOOBU_API_SECRET = "..."  (NOUVEAU secret généré dans le dashboard)
//   node test-smoobu-hmac.mjs
// ============================================================
import crypto from 'node:crypto';

const HOST   = 'https://login.smoobu.com';
const KEY    = process.env.SMOOBU_API_KEY;
const SECRET = process.env.SMOOBU_API_SECRET;
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

if (!KEY)    { console.error('❌ SMOOBU_API_KEY manquant');    process.exit(1); }
if (!SECRET) { console.error('❌ SMOOBU_API_SECRET manquant'); process.exit(1); }

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Construit une requête signée. queryString = déjà trié + tel qu'utilisé dans l'URL.
// canonicalQuery = ce qu'on met dans la signature (peut différer de l'URL pour tester l'encodage).
function signedHeaders(method, path, canonicalQuery, bodyString) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomUUID();
  const bodyHash = bodyString ? sha256hex(bodyString) : EMPTY_SHA256;
  const canonical = [method.toUpperCase(), path, canonicalQuery || '', timestamp, nonce, bodyHash, KEY].join('\n');
  const signature = crypto.createHmac('sha256', SECRET).update(canonical, 'utf8').digest('base64');
  return {
    'Content-Type': 'application/json',
    'Api-Key': KEY,
    'X-API-Key': KEY,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

async function tryReq(label, { method = 'GET', path, urlQuery = '', canonicalQuery = '', body = null } = {}) {
  const bodyString = body != null ? JSON.stringify(body) : '';
  const headers = signedHeaders(method, path, canonicalQuery, method === 'GET' || method === 'DELETE' ? '' : bodyString);
  const url = HOST + path + (urlQuery ? '?' + urlQuery : '');
  const init = { method, headers };
  if (body != null) init.body = bodyString;
  let status, note = '';
  try {
    const res = await fetch(url, init);
    status = res.status;
    if (status === 401) note = (await res.text()).slice(0, 120);
  } catch (e) { status = 'ERR'; note = e.message; }
  const ok = status === 200 || status === 201;
  console.log(`${ok ? '✅' : '❌'} [${status}] ${label}${note ? '  → ' + note : ''}`);
  return ok;
}

// Contrôle : requête NON signée (doit marcher pendant la migration)
async function tryUnsigned(label, path, urlQuery = '') {
  const url = HOST + path + (urlQuery ? '?' + urlQuery : '');
  const res = await fetch(url, { headers: { 'Api-Key': KEY, 'Content-Type': 'application/json' } });
  console.log(`   (contrôle non signé) [${res.status}] ${label}`);
}

const BID = '140560917'; // booking connu existant
const modifiedFrom = '2026-06-01 00:00:00';
const enc = encodeURIComponent(modifiedFrom); // 2026-06-01%2000%3A00%3A00

console.log('=== Contrôle : non signé (référence migration) ===');
await tryUnsigned('GET reservation', `/api/reservations/${BID}`);

console.log('\n=== Requêtes SIGNÉES ===');
// 1) GET sans query
await tryReq('GET /reservations/{id} (0 param)', { path: `/api/reservations/${BID}`, urlQuery: '', canonicalQuery: '' });

// 2) GET 1 query param
await tryReq('GET /reservations/{id}/messages?onlyRelatedToGuest=false', {
  path: `/api/reservations/${BID}/messages`,
  urlQuery: 'onlyRelatedToGuest=false',
  canonicalQuery: 'onlyRelatedToGuest=false',
});

// 3) GET threads (2 params)
await tryReq('GET /threads?page_number=1&page_size=20', {
  path: '/api/threads',
  urlQuery: 'page_number=1&page_size=20',
  canonicalQuery: 'page_number=1&page_size=20',
});

// 4) GET reservations liste (multi param + encodage) — 2 variantes de canonical
console.log('\n--- liste réservations : test des 2 encodages du query string ---');
const urlQ = `modifiedFrom=${enc}&page=1&pageSize=100&showCancellation=true`; // trié alpha, encodé
await tryReq('VARIANTE A : canonical = ENCODÉ (comme URL)', {
  path: '/api/reservations',
  urlQuery: urlQ,
  canonicalQuery: `modifiedFrom=${enc}&page=1&pageSize=100&showCancellation=true`,
});
await tryReq('VARIANTE B : canonical = DÉCODÉ', {
  path: '/api/reservations',
  urlQuery: urlQ,
  canonicalQuery: `modifiedFrom=${modifiedFrom}&page=1&pageSize=100&showCancellation=true`,
});

// 5) POST avec CORPS — valide le body-hash sans muter de donnée réelle.
//    On POST vers un chemin bidon : si l'auth passe (signature du corps correcte),
//    le serveur répond 404/405 (route inconnue) ; si la signature est fausse → 401.
console.log('\n--- POST avec corps : validation du body-hash (chemin bidon, aucune donnée touchée) ---');
{
  const path = '/api/__hmac_probe_ignore__';
  const body = { messageBody: 'signature probe — do not deliver' };
  const bodyString = JSON.stringify(body);
  // (a) corps correctement haché
  const hGood = signedHeaders('POST', path, '', bodyString);
  const rGood = await fetch(HOST + path, { method: 'POST', headers: hGood, body: bodyString });
  // (b) signature volontairement corrompue
  const hBad = { ...hGood, 'X-Signature': 'AAAA' + (hGood['X-Signature'] || '').slice(4) };
  const rBad = await fetch(HOST + path, { method: 'POST', headers: hBad, body: bodyString });
  console.log(`   POST body signé correct  → [${rGood.status}] ${rGood.status === 401 ? '❌ body-hash FAUX' : '✅ auth OK (route inconnue attendue)'}`);
  console.log(`   POST signature corrompue → [${rBad.status}] ${rBad.status === 401 ? '✅ 401 attendu (contrôle)' : '⚠️ pas 401 → auth peut-être après le routage, non concluant'}`);
}

console.log('\nTerminé. Les lignes ✅ [200] valident la signature.');
