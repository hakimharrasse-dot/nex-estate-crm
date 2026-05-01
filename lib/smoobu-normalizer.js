// ============================================================
// /lib/smoobu-normalizer.js
// Logique métier Nex-Estate — portage fidèle de parseSmoobuRow
// Source : index.html (parseSmoobuRow, calcDatePaiement, etc.)
// NE PAS MODIFIER index.html — ce fichier en est l'extraction
// ============================================================

'use strict';

// ── Constantes métier (identiques à index.html) ─────────────
const RABAT = ['Résidence Al Boustane', 'Agdal 13'];
const TAUX  = { rabat: 4, sale: 2 };   // EUR/nuit/pers — Booking.com uniquement
const COM   = {
  'Airbnb':      0.155,
  'Booking.com': 0.22,
  'Direct':      0,
  'VRBO':        0.18,
};
const APPARTS_VALIDES = [
  'Résidence Al Boustane',
  'Agdal 13',
  'Touahri 11',
  'Riad Ahl Sala',
];

// ── Helpers (identiques à index.html) ───────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function diffNuits(ci, co) {
  if (!ci || !co) return 0;
  return Math.max(0, Math.round((new Date(co) - new Date(ci)) / 86400000));
}

// Normalisation date — accepte YYYY-MM-DD, DD.MM.YY, DD.MM.YYYY
function normDate(raw) {
  if (!raw) return '';
  raw = String(raw).trim().split(' ')[0].split('T')[0];
  if (!raw) return '';
  const p = raw.split(/[\/\-\.]/);
  if (p.length !== 3) return '';
  if (p[0].length === 4) {
    return `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
  }
  const yr = p[2].length === 2 ? '20' + p[2] : p[2];
  return `${yr}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
}

function normAmount(raw) {
  if (raw == null || raw === '') return 0;
  return parseFloat(String(raw).replace(/[^\d,.\-]/g, '').replace(',', '.')) || 0;
}

// ── Détection source depuis le nom du canal Smoobu ───────────
function detectSrc(raw) {
  const lw = (raw || '').toLowerCase();
  if (lw.includes('airbnb'))              return 'Airbnb';
  if (lw.includes('booking'))             return 'Booking.com';
  if (lw.includes('vrbo') || lw.includes('homeaway')) return 'VRBO';
  if (lw.includes('direct') || lw.includes('api'))    return 'Direct';
  return 'Direct';
}

// ── Détection appartement (toutes variantes Smoobu) ──────────
function detectAp(raw) {
  if (!raw) return '';
  const lw = raw.toLowerCase();
  if (lw.includes('boustane') || lw.includes('nahda'))            return 'Résidence Al Boustane';
  if (lw.includes('agdal') || lw.includes('biognache'))           return 'Agdal 13';
  if (lw.includes('touahri'))                                      return 'Touahri 11';
  if (lw.includes('riad') || lw.includes('riyad') ||
      lw.includes('ahl')  || lw.includes('sala'))                  return 'Riad Ahl Sala';
  return raw; // inconnu — sera signalé dans _warns
}

// ── Taux taxe séjour par appartement ────────────────────────
function tauxTaxe(appart) {
  return RABAT.includes(appart) ? TAUX.rabat : TAUX.sale;
}

// ── Prochain jeudi après une date (règle Booking.com) ───────
// checkout lun/mar/mer → jeudi même semaine
// checkout jeu/ven/sam/dim → jeudi semaine suivante
function nextThursday(dateStr) {
  if (!dateStr) return '';
  const d   = new Date(dateStr);
  const day = d.getDay(); // 0=dim, 1=lun ... 6=sam
  let daysToAdd;
  if      (day === 0)  daysToAdd = 4;           // dim → +4
  else if (day <= 3)   daysToAdd = 4 - day;     // lun→+3 mar→+2 mer→+1
  else                 daysToAdd = 4 + (7 - day);// jeu→+7 ven→+6 sam→+5
  d.setDate(d.getDate() + daysToAdd);
  return d.toISOString().slice(0, 10);
}

// ── Date de paiement CRM (identique à index.html) ───────────
// Règle : ne jamais utiliser le champ "Payé" de Smoobu
function calcDatePaiement(src, typeNorm, ci, co, dateCreation) {
  const t = today();
  if (typeNorm === 'ANNULATION_NON_PAYEE') return dateCreation || t;
  if (src === 'Airbnb') {
    if (!ci) return dateCreation || t;
    const d = new Date(ci);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (src === 'Booking.com') {
    return nextThursday(co) || dateCreation || t;
  }
  if (src === 'VRBO') {
    if (!ci) return dateCreation || t;
    const d = new Date(ci);
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  return dateCreation || t; // Direct
}

// ============================================================
// NORMALISER UN BOOKING SMOOBU (format API REST)
//
// booking = objet retourné par :
//   - GET /api/reservations  (polling)
//   - webhook payload.data   (push)
//
// Champs API Smoobu :
//   id             → smoobu_id (integer → string)
//   reference-id   → ref plateforme (ex: HMGE7KTKZW)
//   arrival        → checkin  (YYYY-MM-DD)
//   departure      → checkout (YYYY-MM-DD)
//   created-at     → date_creation ("YYYY-MM-DD HH:mm")
//   apartment.name → detectAp()
//   channel.name   → detectSrc()
//   guest-name     → voyageur
//   firstname/lastname
//   email, phone
//   adults, children
//   price          → brut EUR
//   commission-included → pourcentage commission (ex: 22.0 = 22%)
//                         null/0 → fallback taux standards
//   language       → guest_language
//   notice         → notes
//   type           → "reservation" | "cancellation" | ...
//   is-blocked-booking → true → IGNORER
// ============================================================
function normalizeApiBooking(booking) {
  // ── Skip les blocages calendrier ────────────────────────
  if (booking['is-blocked-booking'] === true) return null;

  const smoobuId    = String(booking.id || '');
  const refPlateforme = booking['reference-id'] || smoobuId;

  // ── Dates ───────────────────────────────────────────────
  const ci = normDate(booking.arrival);
  const co = normDate(booking.departure);
  // created-at : "2019-08-08 15:25" → on garde la date uniquement
  const dateCreation = normDate(booking['created-at']);

  // ── Appartement & source ────────────────────────────────
  const rawAppart = (booking.apartment && booking.apartment.name) || '';
  const rawSrc    = (booking.channel   && booking.channel.name)   || '';
  const ap  = detectAp(rawAppart);
  const src = detectSrc(rawSrc);

  // ── Voyageur ────────────────────────────────────────────
  const voyageur = booking['guest-name'] ||
    [booking.firstname, booking.lastname].filter(Boolean).join(' ') || '';
  const phone    = booking.phone || null;
  const email    = booking.email || null;
  const lang     = booking.language || null;
  const adultes  = parseInt(booking.adults)   || 1;
  const enfants  = parseInt(booking.children) || 0;

  // ── Nuits ───────────────────────────────────────────────
  const nuits = diffNuits(ci, co);

  // ── Type normalisation ───────────────────────────────────
  // Règle révisée (2026-05-01) :
  // - Airbnb : ANNULATION_PAYEE seulement si price-details contient
  //   "Cancellation Payout - EUR" (versement hôte confirmé par Airbnb)
  // - Booking.com / VRBO / Direct : ANNULATION_NON_PAYEE par défaut
  //   (cas payés exceptionnels corrigés manuellement + override_manual)
  // - price-paid = "No" pour tous les OTA → non fiable, ne pas utiliser
  const rawType  = (booking.type || '').toLowerCase();
  const isAnnule = rawType.includes('cancel');
  const prixEur  = normAmount(booking.price);
  let typeNorm;
  if (isAnnule) {
    const details = (booking['price-details'] || '').toLowerCase();
    typeNorm = (src === 'Airbnb' && details.includes('cancellation payout - eur'))
      ? 'ANNULATION_PAYEE'
      : 'ANNULATION_NON_PAYEE';
  } else {
    typeNorm = 'RESERVATION';
  }

  // ── Nuits selon type ────────────────────────────────────
  const nuitsFact  = (typeNorm === 'RESERVATION' || typeNorm === 'ANNULATION_PAYEE') ? nuits : 0;
  const nuitsSejou = (typeNorm === 'RESERVATION') ? nuits : 0;

  // ── Commission ──────────────────────────────────────────
  // Smoobu API renvoie commission-included en POURCENTAGE (ex: 22.0 = 22%)
  // Si absent/0 → fallback taux standard CRM
  let comPct, comEurFinal;
  const comRaw = normAmount(booking['commission-included']);
  if (comRaw > 0 && comRaw <= 100) {
    // C'est un pourcentage (0–100 scale)
    comPct      = comRaw / 100;
    comEurFinal = prixEur * comPct;
  } else {
    comPct      = COM[src] || 0;
    comEurFinal = prixEur * comPct;
  }
  let netEur = prixEur - comEurFinal;

  // ── ANNULATION_NON_PAYEE → tout à 0 ─────────────────────
  if (typeNorm === 'ANNULATION_NON_PAYEE') {
    netEur = 0; comEurFinal = 0; comPct = 0;
  }

  // ── Taxe séjour ─────────────────────────────────────────
  // Booking.com uniquement — hors CA (argent État)
  let taxeEur = 0;
  if (src === 'Booking.com' && nuitsSejou > 0 && ap) {
    taxeEur = nuitsSejou * adultes * tauxTaxe(ap);
  }

  // ── Date paiement CRM ───────────────────────────────────
  const dp = calcDatePaiement(src, typeNorm, ci, co, dateCreation);

  // ── Statut CRM ──────────────────────────────────────────
  // Règle : ne jamais utiliser price-paid / statut Smoobu
  let statut;
  if (typeNorm === 'ANNULATION_NON_PAYEE') {
    statut = 'Annulé';
  } else {
    statut = (dp && today() >= dp) ? 'Payé' : 'En attente';
  }

  // ── Validation warnings ──────────────────────────────────
  const warns = [];
  if (!ci)                                    warns.push('checkin manquant');
  if (!co)                                    warns.push('checkout manquant');
  if (!APPARTS_VALIDES.includes(ap))          warns.push(`appart inconnu: ${rawAppart.slice(0, 25)}`);
  if (!prixEur && typeNorm !== 'ANNULATION_NON_PAYEE') warns.push('montant nul');

  // ── Notes ───────────────────────────────────────────────
  const notes = booking.notice || booking['assistant-notice'] || '';

  return {
    id:            uid(),
    ref:           refPlateforme,
    smoobu_id:     smoobuId,
    source:        src,
    appart:        ap,
    voyageur:      voyageur,
    phone:         phone,
    email:         email,
    guest_language: lang,
    adults:        adultes || null,
    children:      enfants,
    checkin:       ci,
    checkout:      co,
    nuits_sejour:  nuitsSejou,
    nuits_fact:    nuitsFact,
    nb_personnes:  adultes,
    brut:          Math.round(prixEur    * 100) / 100,
    com_pct:       Math.round(comPct     * 100000) / 100000,
    commission:    Math.round(comEurFinal * 100) / 100,
    net:           Math.round(netEur     * 100) / 100,
    taxe_sejour:   Math.round(taxeEur    * 100) / 100,
    type_norm:     typeNorm,
    mode_paiement: 'Virement plateforme',
    statut:        statut,
    date_creation: dateCreation,
    date_paiement: dp,
    mois_kpi:      (dp || ci).slice(0, 7),
    notes:         notes,
    // ── Méta (nettoyé avant upsert) ─────────────────────
    _warns:        warns,
    _hasWarn:      warns.length > 0,
  };
}

// ── Nettoyage des champs méta avant envoi Supabase ──────────
function stripMeta(entry) {
  const { _warns, _hasWarn, ...clean } = entry;
  return clean;
}

module.exports = {
  normalizeApiBooking,
  stripMeta,
  detectSrc,
  detectAp,
  // Exposés pour tests unitaires
  normDate,
  normAmount,
  calcDatePaiement,
  nextThursday,
  APPARTS_VALIDES,
};
