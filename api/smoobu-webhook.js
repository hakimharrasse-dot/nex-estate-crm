// ============================================================
// /api/smoobu-webhook.js
// Récepteur webhooks Smoobu → normalise → upsert Supabase
//
// Configurer dans Smoobu :
//   Settings → Advanced → API Keys → Webhook URLs
//   URL : https://<votre-domaine>.vercel.app/api/smoobu-webhook
//
// Actions gérées :
//   newReservation    → normalize + upsert
//   updateReservation → normalize + upsert (même logique)
//   cancelReservation → normalize (type forced cancel) + upsert
//   deleteReservation → soft-delete : statut=Annulé + note (zéro perte de données)
// ============================================================

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { normalizeApiBooking, stripMeta } = require('../lib/smoobu-normalizer');

// ── Client Supabase (SERVICE_ROLE côté backend uniquement) ──
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes');
  return createClient(url, key);
}

// ── Upsert une réservation (clé = smoobu_id) ────────────────
async function upsertResa(supabase, entry) {
  if (!entry.smoobu_id) {
    console.warn('[webhook] smoobu_id manquant — upsert ignoré', entry.ref);
    return { skipped: true };
  }

  const clean = stripMeta(entry);

  // On upsert sur smoobu_id (clé de déduplication Smoobu)
  // Supabase exige un index UNIQUE sur smoobu_id pour onConflict
  // → voir schéma SQL : CREATE UNIQUE INDEX uq_resa_smoobu_id ON resa (smoobu_id);
  const { data, error } = await supabase
    .from('resa')
    .upsert(clean, { onConflict: 'smoobu_id', ignoreDuplicates: false });

  if (error) throw error;
  return { ok: true, ref: entry.ref, type: entry.type_norm };
}

// ── Soft-delete : marquer Annulé sans supprimer la ligne ────
// Règle : zéro perte de données automatique.
// - statut → "Annulé"
// - notes  → notes existantes + " | Deleted from Smoobu"
// - type_norm → "ANNULATION_NON_PAYEE" seulement si brut = 0
//   (si brut > 0 on garde ANNULATION_PAYEE — argent déjà versé)
async function softDeleteResa(supabase, smoobuId) {
  if (!smoobuId) return { skipped: true };

  const sid = String(smoobuId);

  // 1. Lire l'entrée existante pour préserver notes et brut
  const { data: existing, error: fetchErr } = await supabase
    .from('resa')
    .select('notes, brut, type_norm')
    .eq('smoobu_id', sid)
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  if (!existing) {
    // Entrée inconnue en base — rien à faire
    console.warn('[webhook] deleteReservation: smoobu_id introuvable en base:', sid);
    return { skipped: true, reason: 'not_found' };
  }

  const existingNotes = existing.notes || '';
  const suffix        = 'Deleted from Smoobu';
  const newNotes      = existingNotes.includes(suffix)
    ? existingNotes
    : (existingNotes ? `${existingNotes} | ${suffix}` : suffix);

  // type_norm : garder ANNULATION_PAYEE si brut > 0, sinon ANNULATION_NON_PAYEE
  const newType = (existing.brut > 0) ? 'ANNULATION_PAYEE' : 'ANNULATION_NON_PAYEE';

  // 2. Update partiel — on ne touche qu'aux champs nécessaires
  const { error: updateErr } = await supabase
    .from('resa')
    .update({
      statut:    'Annulé',
      notes:     newNotes,
      type_norm: newType,
    })
    .eq('smoobu_id', sid);

  if (updateErr) throw updateErr;
  return { ok: true, soft_deleted: sid, type_norm: newType };
}

// ── Handler principal Vercel ─────────────────────────────────
module.exports = async function handler(req, res) {
  // Smoobu envoie toujours un POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let payload;
  try {
    // Vercel parse automatiquement le JSON si Content-Type: application/json
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    console.error('[webhook] body parse error:', e.message);
    return res.status(400).json({ error: 'Body JSON invalide' });
  }

  const { action, data: booking } = payload || {};

  console.log('[webhook] action reçue:', action, '| booking_id:', booking?.id);

  if (!action || !booking) {
    return res.status(400).json({ error: 'Payload invalide — action ou data manquant' });
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (e) {
    console.error('[webhook] Supabase init error:', e.message);
    return res.status(500).json({ error: 'Configuration Supabase manquante' });
  }

  try {
    switch (action) {

      // ── Nouvelle réservation ───────────────────────────────
      case 'newReservation': {
        const entry = normalizeApiBooking(booking);
        if (!entry) {
          console.log('[webhook] newReservation ignorée (blocked booking):', booking.id);
          return res.status(200).json({ ok: true, skipped: 'blocked_booking' });
        }
        if (entry._hasWarn) {
          console.warn('[webhook] warnings:', entry._warns.join(', '), '| ref:', entry.ref);
        }
        const result = await upsertResa(supabase, entry);
        console.log('[webhook] newReservation upserted:', result);
        return res.status(200).json({ ok: true, action, result });
      }

      // ── Mise à jour réservation ────────────────────────────
      // Même logique que new — l'upsert sur smoobu_id écrase l'existant
      case 'updateReservation': {
        const entry = normalizeApiBooking(booking);
        if (!entry) {
          return res.status(200).json({ ok: true, skipped: 'blocked_booking' });
        }
        if (entry._hasWarn) {
          console.warn('[webhook] warnings:', entry._warns.join(', '), '| ref:', entry.ref);
        }
        const result = await upsertResa(supabase, entry);
        console.log('[webhook] updateReservation upserted:', result);
        return res.status(200).json({ ok: true, action, result });
      }

      // ── Annulation ────────────────────────────────────────
      // Smoobu envoie le booking avec type "cancellation"
      // → normalizeApiBooking détecte ANNULATION_PAYEE ou ANNULATION_NON_PAYEE
      case 'cancelReservation': {
        // Forcer le type cancel si Smoobu n'a pas mis le flag
        const bookingWithCancel = {
          ...booking,
          type: 'cancellation',
        };
        const entry = normalizeApiBooking(bookingWithCancel);
        if (!entry) {
          return res.status(200).json({ ok: true, skipped: 'blocked_booking' });
        }
        const result = await upsertResa(supabase, entry);
        console.log('[webhook] cancelReservation upserted:', result);
        return res.status(200).json({ ok: true, action, result });
      }

      // ── Suppression Smoobu → soft-delete uniquement ───────
      // Jamais de DELETE physique — zéro perte de données
      case 'deleteReservation': {
        const smoobuId = String(booking.id || '');
        const result   = await softDeleteResa(supabase, smoobuId);
        console.log('[webhook] deleteReservation (soft):', result);
        return res.status(200).json({ ok: true, action, result });
      }

      // ── Action inconnue ───────────────────────────────────
      default:
        console.log('[webhook] action non gérée:', action);
        return res.status(200).json({ ok: true, skipped: `action non gérée: ${action}` });
    }

  } catch (err) {
    console.error('[webhook] erreur traitement:', err.message, err);
    return res.status(500).json({ error: err.message });
  }
};
