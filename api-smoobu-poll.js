// ============================================================
// /api/smoobu-poll.js
// Polling Smoobu → normalise → upsert Supabase
//
// Appelé par le cron Vercel toutes les heures.
// Peut aussi être déclenché manuellement : GET /api/smoobu-poll
// Paramètre optionnel : ?hours=N (fenêtre en heures, défaut 2h)
//
// Stratégie :
//   - Récupère les réservations modifiées depuis now()-Nh
//   - Fenêtre de 2h avec cron 1h → chevauchement intentionnel
//     pour éviter les manques (upsert est idempotent)
//   - Pagination complète (pageSize 100)
//   - Skip les bookings bloqués (is-blocked-booking: true)
// ============================================================

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { normalizeApiBooking, stripMeta } = require('../lib/smoobu-normalizer');

const SMOOBU_API = 'https://login.smoobu.com/api';
const PAGE_SIZE  = 100; // max recommandé Smoobu
const DEFAULT_WINDOW_HOURS = 2; // fenêtre chevauchante (cron = 1h)

// ── Client Supabase ─────────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes');
  return createClient(url, key);
}

// ── Headers Smoobu API ───────────────────────────────────────
function smoobuHeaders() {
  const key = process.env.SMOOBU_API_KEY;
  if (!key) throw new Error('Variable SMOOBU_API_KEY manquante');
  return {
    'Api-Key':      key,
    'Cache-Control':'no-cache',
    'Content-Type': 'application/json',
  };
}

// ── Fetch une page de réservations Smoobu ───────────────────
async function fetchPage(modifiedFrom, page) {
  const params = new URLSearchParams({
    modifiedFrom,
    pageSize: PAGE_SIZE,
    page,
  });

  const url = `${SMOOBU_API}/reservations?${params}`;
  console.log(`[poll] fetch page ${page} — modifiedFrom: ${modifiedFrom}`);

  const response = await fetch(url, { headers: smoobuHeaders() });

  if (response.status === 429) {
    throw new Error('Rate limit Smoobu atteint (1000 req/min) — relancer dans 1 min');
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Smoobu API erreur ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json();
}

// ── Récupérer toutes les réservations modifiées (pagination) ─
async function fetchAllModified(modifiedFrom) {
  let allBookings = [];
  let page = 1;

  while (true) {
    const data = await fetchPage(modifiedFrom, page);
    const bookings = data.bookings || data.data || [];

    if (!Array.isArray(bookings) || bookings.length === 0) break;

    allBookings = allBookings.concat(bookings);

    const pageCount  = data.page_count  || data.pageCount  || 1;
    const totalItems = data.total_items || data.totalItems || bookings.length;

    console.log(`[poll] page ${page}/${pageCount} — ${bookings.length} bookings — total: ${totalItems}`);

    if (page >= pageCount || allBookings.length >= totalItems) break;
    page++;
  }

  return allBookings;
}

// ── Upsert batch dans Supabase ───────────────────────────────
// Supabase accepte des tableaux dans .upsert()
// onConflict: 'smoobu_id' → nécessite index UNIQUE sur smoobu_id
async function upsertBatch(supabase, entries) {
  if (!entries.length) return { count: 0 };

  const clean = entries.map(stripMeta);

  const { error, count } = await supabase
    .from('resa')
    .upsert(clean, {
      onConflict:       'smoobu_id',
      ignoreDuplicates: false, // false = update si conflit
    });

  if (error) throw error;
  return { count: entries.length };
}

// ── Handler principal Vercel ─────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Fenêtre configurable via ?hours=N (défaut 2h)
  const windowHours = parseInt(req.query?.hours) || DEFAULT_WINDOW_HOURS;

  // Calculer modifiedFrom = now() - windowHours
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const modifiedFrom = since.toISOString().slice(0, 19).replace('T', ' '); // "YYYY-MM-DD HH:mm:ss"

  console.log(`[poll] démarrage — fenêtre: ${windowHours}h — modifiedFrom: ${modifiedFrom}`);

  let supabase;
  try {
    supabase = getSupabase();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const stats = {
    fetched:  0,
    skipped:  0,  // blocked bookings
    warnings: 0,
    errors:   0,
    upserted: 0,
  };

  try {
    // 1. Récupérer toutes les réservations modifiées
    const rawBookings = await fetchAllModified(modifiedFrom);
    stats.fetched = rawBookings.length;
    console.log(`[poll] ${stats.fetched} réservations récupérées`);

    if (!rawBookings.length) {
      return res.status(200).json({
        ok: true,
        modifiedFrom,
        stats,
        message: 'Aucune réservation modifiée dans la fenêtre',
      });
    }

    // 2. Normaliser
    const toUpsert = [];
    for (const booking of rawBookings) {
      try {
        const entry = normalizeApiBooking(booking);
        if (!entry) {
          stats.skipped++;
          continue; // blocked booking
        }
        if (entry._hasWarn) {
          stats.warnings++;
          console.warn('[poll] warning:', entry._warns.join(', '), '| smoobu_id:', entry.smoobu_id);
        }
        if (!entry.smoobu_id) {
          stats.skipped++;
          continue; // pas de clé unique → impossible à upsert proprement
        }
        toUpsert.push(entry);
      } catch (err) {
        stats.errors++;
        console.error('[poll] erreur normalisation booking:', booking?.id, err.message);
      }
    }

    // 3. Upsert par batches de 50 (limite recommandée Supabase)
    const BATCH = 50;
    for (let i = 0; i < toUpsert.length; i += BATCH) {
      const chunk = toUpsert.slice(i, i + BATCH);
      try {
        const result = await upsertBatch(supabase, chunk);
        stats.upserted += result.count;
        console.log(`[poll] batch ${Math.floor(i / BATCH) + 1} upserted: ${result.count}`);
      } catch (err) {
        stats.errors++;
        console.error('[poll] erreur upsert batch:', err.message);
      }
    }

    console.log('[poll] terminé —', JSON.stringify(stats));

    return res.status(200).json({
      ok: true,
      modifiedFrom,
      stats,
    });

  } catch (err) {
    console.error('[poll] erreur fatale:', err.message, err);
    return res.status(500).json({
      error:      err.message,
      modifiedFrom,
      stats,
    });
  }
};
