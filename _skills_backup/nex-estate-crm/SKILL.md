---
name: nex-estate-crm
description: "Skill maître CRM Nex-Estate.   Gère :  - règles métier   - KPIs   - logique de devise (EUR stockage / MAD affichage)   - structure de l'app (réservations, dépenses, taxe, extras)    Contexte :   Gestion locative courte durée à Rabat / Salé.   Base officielle = Supabase (localStorage = ancien système / backup uniquement).    Déclencher ce skill si :   CRM, dashboard, KPI, transactions, réservations, annulations, relocation, taxe de séjour, ménage, extras, dépenses, revenus, marge, ADR, RevPAN, taux d'occupation, EUR, MAD, ou noms des logements.    Ne pas déclencher pour :   tâches d'import de données (CSV, XLS, parsing)"
---

CRM Nex-Estate — Règles Métier Maîtres (mis à jour 2026-06-08)

Tu es l'expert métier de Nex-Estate. Tu exécutes directement — jamais d'instructions manuelles.

---

ARCHITECTURE

App web HTML/JS → index.html unique (~14 474 lignes), vanilla JS, zéro framework
Smoobu → Channel manager (opérationnel) — webhook temps réel + cron horaire
PriceLabs → Pricing
Vercel → Hébergement (nex-estate-seven.vercel.app)
Base de données → Supabase (source officielle, PostgreSQL 17)
Auth → Supabase Auth (email/password), rôles admin / manager / user

---

RÈGLE FONDAMENTALE — DEVISE

- Réservations → stockées en EUR
- Dépenses / Taxe / Extras → en MAD

⚠️ Conversion EUR → MAD UNIQUEMENT dans le dashboard
⚠️ Ne jamais convertir à l'import
⚠️ Ne jamais fixer un taux en dur (sauf fallback technique temporaire si API indisponible)
⚠️ Taux temps réel via frankfurter.app (variable globale EUR_MAD)

---

AFFICHAGE

- Tous les KPI affichés en MAD
- Conversion temps réel via API (frankfurter.app)
- Aucun affichage EUR côté utilisateur

---

PORTEFEUILLE

Rabat (taxe 4€/nuit/pers — Booking uniquement)
- Résidence Al Boustane
- Agdal 13

Salé (taxe 2€/nuit/pers — Booking uniquement)
- Touahri 11
- Riad Ahl Sala

Inactif (archivé)
- Studio Ocean (fin janvier 2026) — logement historique valide, 11 réservations importées manuellement, aucun smoobu_id

---

LOGEMENTS ACTIFS / ARCHIVÉS (TABLE `logements`)

- Un logement archivé reste visible dans l'historique pour toutes réservations antérieures à sa date de restitution
- Il n'affecte pas les KPIs des mois postérieurs à sa restitution
- Studio Ocean : exploité en janvier et début février 2026 — ses réservations doivent rester visibles sur ces mois
- getNbLogementsForPeriod() utilise la vue v_logements_actifs_par_mois (Supabase, security_invoker=true)

---

TAXE DE SÉJOUR

- Booking uniquement
- Airbnb / Direct / VRBO = 0

Calcul :
- Rabat → 4€ × nuits × personnes
- Salé → 2€ × nuits × personnes

Collectée en cash terrain
⚠️ Hors chiffre d'affaires principal (argent État), mais incluse dans le total revenus globaux du dashboard

---

ÉQUIPE MÉNAGE (TRÈS IMPORTANT)

Net à payer =
Ménage effectué
+ Dépenses avancées
− Taxe collectée
− Extras collectés

Si négatif → elle te doit
Si positif → tu lui dois

⚠️ Calcul opérationnel (cash terrain)
⚠️ Ne jamais mélanger avec le résultat net business

---

SERVICES ADDITIONNELS (EXTRAS)

Types (CATS_S — 11 valeurs) :
- Navette, Ménage supplémentaire, Linge supplémentaire, Arrivée anticipée, Départ tardif
- Climatisation, Voyageur supplémentaire, Parking, Petit-déjeuner, Baby-sitting, Autres

Multi-services (depuis 2026-06-08) : un service peut inclure plusieurs types → svc stocke "Arrivée anticipée, Climatisation"
Colonne `note` : détail libre optionnel (TEXT NULL, migration add_note_to_serv)
Colonne `pay_source` : null=Terrain, 'Airbnb', 'Booking', 'Autre'
Colonne `resa_ref` : référence réservation Airbnb pour matching Réconciliation (P0)

Devise = MAD. Collecté terrain. Table `serv`.

---

COMMISSIONS (AUTO)

Booking → 22%
Airbnb → 15.5%
Direct → 0%
VRBO → 18%

⚠️ Toujours recalculer — ne jamais importer commission Smoobu brute
⚠️ Smoobu renvoie commission-included en POURCENTAGE (ex: 22.0 = 22%), à diviser par 100

---

TYPES RÉSERVATIONS (type_norm)

RESERVATION → revenu + nuits séjour + nuits business
ANNULATION_PAYEE → revenu + nuits business uniquement (nuits_sejour=0)
ANNULATION_NON_PAYEE → ignoré (statut=Annulé, aucun KPI)
RELOCATION → revenu + nuits (traitement identique à RESERVATION)
AIRCOVER → revenu uniquement (0 nuit, encaissement ponctuel Airbnb)
AJUSTEMENT → revenu uniquement (0 nuit, encaissement ponctuel Airbnb)
DIRECT → revenu + nuits

---

RÈGLES DATE_PAIEMENT (IMMUABLES)

Airbnb RESERVATION / ANNULATION_PAYEE / RELOCATION → checkin + 1 jour
Airbnb AIRCOVER / AJUSTEMENT → saisie manuelle uniquement (jamais recalculée par recomputeAndSave)
Booking.com → prochain jeudi après checkout
VRBO → checkin + 7 jours
Direct → date_creation
Annulation non payée → date_creation

mois_kpi = date_paiement.slice(0,7) — TOUJOURS basé sur date_paiement, jamais sur checkin

---

RÈGLES STATUT

ANNULATION_NON_PAYEE → statut = 'Annulé'
Autres → date_paiement <= aujourd'hui ? 'Payé' : 'En attente'

---

KPIs DASHBOARD

Filtre : filterResa() → mois_kpi (mode mois) ou date_paiement (mode semaine/jour)
CA encaissé = sumNetMAD(revPaye) où revPaye = lignes avec date_paiement <= aujourd'hui
CA en attente = sumNetMAD(revAtt) où revAtt = lignes avec date_paiement > aujourd'hui

ADR = revenus nets / nuits facturées
Taux occupation = nuits séjour physiques / jours disponibles
RevPAN = revenus nets / jours disponibles
Marge = résultat net / revenus nets

Résultat net = CA encaissé − Dépenses business
Total dépenses = dépenses business (hors Avance caisse, hors Règlement terrain)

⚠️ Toutes conversions EUR → MAD au moment du calcul KPI — jamais en base

---

HELPERS MAD (CRITIQUE — déployés 2026-05-17)

var MAD_REEL_ELIGIBLE = ['RESERVATION','ANNULATION_PAYEE','RELOCATION','AIRCOVER','AJUSTEMENT'];

rNetMAD(r)  → r.mad_reel si éligible, sinon r.net × EUR_MAD
rBrutMAD(r) → r.brut × r.taux_reel si éligible, sinon r.brut × EUR_MAD
rComMAD(r)  → r.commission × r.taux_reel si éligible, sinon r.commission × EUR_MAD
sumNetMAD(rows) → Σ rNetMAD(r)

⚠️ Ces helpers sont utilisés dans TOUS les calculs KPI du dashboard et de renderResa
⚠️ AIRCOVER et AJUSTEMENT éligibles si mad_reel renseigné (depuis Réconciliation Check D)

---

MODULE MAD RÉEL — RÉCONCILIATION AIRBNB (stabilisé 2026-05-17)

Champs DB sur table `resa` :
- mad_reel : montant net MAD réellement encaissé
- taux_reel : taux EUR→MAD du versement (null si natif MAD)
- mad_reel_source : 'CSV Airbnb payout' / 'CSV Airbnb MAD natif' / 'CSV Airbnb complexe / validation manuelle'
- mad_reel_updated_at : ISO datetime

Ces champs ne sont JAMAIS écrits par webhook, poll ou import CSV Smoobu.
Source CSV = CSV paiements Airbnb (séparateur virgule, encodage UTF-8, nombres format FR).

TYPES_OK (auto-apply) : RESERVATION, ANNULATION_PAYEE, RELOCATION
AIRCOVER, AJUSTEMENT, RESOLUTION → jamais auto-apply

---

MODULE MAD RÉEL — RÉCONCILIATION BOOKING (stabilisé 2026-05-18)

2 étapes :
1. CSV global "Informations de versement" (ISO-8859-1) → montants EUR, groupés par batch
2. PDF par batch "Relevé du paiement" → taux exact 6 décimales, MAD total

Champs DB écrits : mad_reel = net_EUR × taux_reel, taux_reel, mad_reel_source='booking_pdf'
Guard : ne jamais écraser un mad_reel déjà renseigné.

Source-agnostique : rNetMAD/rBrutMAD/rComMAD s'appliquent à Airbnb ET Booking.

---

OCCUPATION PHYSIQUE (nuit par nuit)

occupNightsBiz(appart, pStart, pEnd) → nuits des types [RESERVATION, RELOCATION, DIRECT, ANNULATION_PAYEE]
qui tombent physiquement dans [pStart, pEnd[, calculées par chevauchement checkin/checkout.

effectiveNightsInPeriod(r, pStart, pEnd) :
- Si nuits_business != null → distribué proportionnellement (nuits_business × overlap / totalNights)
- Sinon → nightsInPeriod(checkin, checkout, pStart, pEnd)

⚠️ Aucun filtre par date_paiement pour l'occupation — c'est du physique

---

CHAMP NUITS_BUSINESS (override optionnel)

- Si null → occupation calculée automatiquement par chevauchement de dates
- Si renseigné → remplace le calcul auto (pro-raté si séjour chevauche plusieurs mois)
- Préservé lors des imports CSV (confirmCSV) et syncs API partielles (override_manual=true)
- Visible dans le formulaire réservation (id: fi-nuits-biz)

---

OVERRIDE_MANUAL (PROTECTION TRIPLE)

override_manual = true → réservation protégée contre l'écrasement automatique
- Fix 1 (import CSV) : confirmCSV() ne touche pas les champs financiers si override_manual=true
- Fix 2 (webhook) : smoobu-webhook.js lit override_manual avant tout upsert
- Fix 3 (poll) : smoobu-poll.js ne remet jamais override_manual=false sur un record existant

---

DÉPENSES BUSINESS — CATS_B COMPLET (18 catégories)

Ménage, Loyer, Eau & Électricité, Internet / Fibre, Frais de syndic,
Consommables, Technicien, Intervention, Maintenance, Ameublement / Décoration,
Travaux / Rénovation, Assurance, Frais bancaires, Transport / déplacements,
Outils / logiciels, Avance caisse, Règlement terrain, Autre

EXCLUSIONS KPI IMMUABLES :
- Avance caisse → exclue de bizRows (KPI) ET bizPeriod (cash dashboard) ET bPend
- Règlement terrain → exclue de bizRows ET bizPeriod ET bPend
⚠️ Ces deux catégories ne doivent JAMAIS entrer dans le résultat net business

---

DÉPENSES PERSO

Crédit, Loyer perso, Pension, Famille, École, Abonnements,
Alimentation, Resto / Café, Santé, Vêtements, Sport,
Loisirs, Transport, Autre

Colonne `don` (ajouté 2026-05-06) : checkbox "Don / pourboire", badge 💝 dans l'affichage.
Visible uniquement pour le rôle admin.

PATRIMOINE / INVESTISSEMENT PERSO (ajouté 2026-06-26) :
2 natures de dépense perso séparées via la catégorie (PAS de migration Supabase) :
- Dépenses courantes (CATS_P_COURANT, 22 catégories) → budget mensuel
- Patrimoine / Investissement (CATS_P_INVEST, 6 catégories VEFA + Autre invest)

CATS_P_INVEST = VEFA – Avance appartement / Frais notaire / Frais dossier-banque /
                Ameublement initial / Travaux-finitions / Autre investissement perso
Helper unique : isInvestPerso(cat) → vrai si cat ∈ CATS_P_INVEST.
CATS_P = CATS_P_COURANT.concat(CATS_P_INVEST) (source unique filtres/affichage).

⚠️ Le total principal du budget perso (KPI "Dépenses courantes" + Famille + Crédit
   + En attente) ne compte QUE les dépenses courantes — les avances VEFA ne faussent
   jamais le budget mensuel.
⚠️ KPI séparés : Dépenses courantes / Investissements-Patrimoine / Total général perso
   (rangée p-kg-invest affichée seulement si VEFA dans la période).
⚠️ Résumé catégories : section dédiée "🏗 Patrimoine / Investissement perso".
⚠️ VEFA exclu des charges récurrentes (form rcp-cat = CATS_P_COURANT) → n'affecte pas
   calcLissePerso() / budget lissé. VEFA hors CATS_P_FIXED.

---

AVANCE CAISSE / SOLDER — ARCHITECTURE (validée 2026-05-04)

Reçu (avances) = cat=Avance caisse, fmen=membre, statut=Payé
Utilisé = dépenses réelles Payé imputées au membre (cat≠Avance caisse, cat≠Règlement terrain)
Solde net = Reçu + Collecté terrain − Utilisé

Flux Solder (confirmSolde()) :
1. Dépenses pendantes → Payé
2. Si cat=Ménage ET paid_by=payeur → paid_by=null (neutralisation anti double-comptage)
3. Taxe de séjour → Reversé
4. Services → Payé
5. Crée "Règlement terrain" (cat=Règlement terrain, statut=Payé)

---

SYNC SMOOBU (opérationnel depuis 2026-04-29)

Webhook temps réel : /api/smoobu-webhook.js (POST Smoobu → CRM)
Cron horaire : /api/smoobu-poll.js (0 * * * * via vercel.json)
Backfill manuel : GET /api/smoobu-poll?from=YYYY-MM-DD

Logique poll (3 cas) :
A. smoobu_id absent → INSERT avec uid()
B. override_manual=true → UPDATE partiel (dates/voyageur uniquement)
C. Sinon → UPDATE complet

⚠️ nextThursday() UTC-safe dans poll + normalizer (sync parité avec Recalculer)

---

STRUCTURE APP

Modules : Réservations, Dépenses Business, Taxe, Extras, Dépenses Perso, Logements
Réconciliation : onglet dédié — Airbnb CSV paiements + Booking CSV+PDF

Stockage principal = Supabase
localStorage = ancien système (legacy uniquement)
Export / Import JSON = backup / migration

---

RÈGLE ABSOLUE

Ne jamais mélanger :
- Performance business (KPI)
- Flux terrain (ménage, taxe, extras)

Les règles métier priment sur tout fichier ou historique.

Ne jamais toucher sans instruction explicite :
- CA, date_paiement, mois_kpi et leurs calculs
- KPIs existants et leur logique
- mad_reel / taux_reel des réservations réconciliées
- Design et layout général du CRM
