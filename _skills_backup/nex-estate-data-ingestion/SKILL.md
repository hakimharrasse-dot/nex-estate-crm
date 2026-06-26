---
name: nex-estate-data-ingestion
description: "Skill d'import des données vers le CRM Nex-Estate.  Rôle : - lire les fichiers d'export - mapper les colonnes - normaliser les données - préparer l'insertion dans le CRM (Supabase)  Sources principales : - CSV Smoobu - CSV Airbnb paiements - CSV Booking versements - PDF Booking par batch  Contexte : Les données sont importées dans Supabase (base officielle). Les fichiers sont une base de travail uniquement, jamais une source de vérité.  Déclencher ce skill si : import, ingestion, CSV, XLS, XLSX, Smoobu, Airbnb export, Booking export, fichier de réservation, historique de transactions, données de paiement, synchronisation, transfert vers CRM.  Ne pas déclencher pour : KPI, dashboard, règles métier globales."
---

Nex-Estate Data Ingestion (mis à jour 2026-05-19)

Tu traites les fichiers d'export pour les préparer à l'insertion dans le CRM Nex-Estate (app HTML/JS + Supabase).

Destination finale = Supabase (base officielle).

---

RÈGLE ABSOLUE
Les règles métier de l'utilisateur priment sur tout (fichier, historique, export).

---

SOURCES ET PRIORITÉS

1. Smoobu sync (webhook + cron) = SOURCE PRINCIPALE pour les réservations
   - Webhook temps réel : POST de Smoobu → /api/smoobu-webhook.js
   - Cron horaire : /api/smoobu-poll.js (0 * * * *)
   - Backfill manuel : GET /api/smoobu-poll?from=YYYY-MM-DD

2. CSV Smoobu = source secondaire / correction historique
   - Import via confirmCSV() dans l'interface CRM
   - Utilisé principalement pour les mois avant l'intégration Smoobu

3. CSV Airbnb paiements = réconciliation MAD uniquement (pas de réservations)
   - Encodage UTF-8, séparateur virgule, nombres format FR (3 537,17)
   - NE contient PAS les réservations — contient les versements Airbnb avec montants MAD

4. CSV Booking "Informations de versement" = réconciliation EUR + batch identification
   - Encodage ISO-8859-1 (double-encodé), séparateur point-virgule
   - Contient : Numéro de référence, Net EUR, Identifiant du paiement (batch CSV), Date paiement

5. PDF Booking "Relevé du paiement" = réconciliation MAD taux exact
   - Contient : taux de change (6 décimales), MAD total versé, ID numérique PDF
   - ⚠️ ID batch PDF ≠ ID batch CSV — matching par date + total EUR, pas par ID

---

PROTECTION OVERRIDE_MANUAL (CRITIQUE)

override_manual = true → réservation protégée contre l'écrasement automatique

Lors de tout import CSV ou sync API :
- Si override_manual = true → ne jamais écraser brut, commission, net, com_pct
- Préserver toujours nuits_business (jamais écrasé par aucune source)
- Les champs date_paiement, mois_kpi, statut peuvent être mis à jour par recomputeAndSave() uniquement

---

PROBLÈMES CONNUS SMOOBU

- Résidence Al Boustane : CSV affiche les prix en MAD (ex: 1207.68 MAD) alors que la base stocke en EUR → JAMAIS importer montants Al Boustane depuis CSV Smoobu sans vérification
- Annulations payées non fiables dans CSV Smoobu
- Relocations parfois absentes
- commission-included Smoobu à ignorer → toujours recalculer COM[src]

---

WORKFLOW IMPORT CSV SMOOBU

1. Lire fichier CSV (séparateur virgule, encodage UTF-8)
2. Parser via parseSmoobuRow()
3. Mapper colonnes → format CRM
4. Calculer champs auto (date_paiement, mois_kpi, commission, type_norm)
5. Guard override_manual : si true → ne pas écraser champs financiers
6. Préserver nuits_business existant
7. Upsert Supabase sur smoobu_id (clé UNIQUE uq_resa_smoobu_id)
8. Afficher log import (stocké dans localStorage smoobu_import_log)

---

MODULE RÉCONCILIATION AIRBNB CSV (stabilisé 2026-05-17)

Objectif : stocker mad_reel (MAD réellement encaissé) sur chaque réservation Airbnb.

TYPES_OK (éligibles à l'écriture) : RESERVATION, ANNULATION_PAYEE, RELOCATION
JAMAIS auto-apply : AIRCOVER, AJUSTEMENT, RESOLUTION

Champs écrits en base :
- mad_reel : montant net MAD
- taux_reel : taux EUR→MAD (null si natif MAD)
- mad_reel_source : 'CSV Airbnb payout' / 'CSV Airbnb MAD natif' / 'CSV Airbnb complexe / validation manuelle'
- mad_reel_updated_at : ISO datetime

Guards addRow() (ordre obligatoire) :
1. TYPES_OK : type_norm doit être dans la liste
2. Natif MAD (_isNativeMad) : RESERVATION uniquement + findByCode strict
3. _natifForceComplex : plusieurs RESERVATION même code → manuel
4. _hasNetMismatch : |crm.net - csvRow.net| > 1 EUR → complexe, jamais auto
5. isSimpleRow : taux dans plage ET pas USD ET pas régularisation

Règle immuable : ces champs ne sont jamais écrits par webhook, poll ou CSV Smoobu.

---

MODULE RÉCONCILIATION BOOKING (stabilisé 2026-05-18)

Flux complet :
1. Import CSV global → anomalies EUR (écart >0.50€) + manquantes détectées
2. 📐 Aligner sur CSV → patch brut/commission/net réels + override_manual=true
3. Upload PDF par batch → taux exact (6 décimales) + MAD total → applyBkBatch()
4. mad_reel = net_EUR × taux_reel stocké en base

États batch : eur_only → pdf_ready → applied (figé)
Guard : ne jamais écraser mad_reel déjà renseigné.

---

CAS À GÉRER MANUELLEMENT (OBLIGATOIRE)

- Annulations payées (règle Smoobu non fiable)
- Relocations
- AirCover et Ajustements Airbnb (date_paiement saisie manuelle uniquement)
- Studio Ocean : aucun smoobu_id → jamais de sync auto — saisie manuelle uniquement

---

PORTEFEUILLE

Rabat (taxe 4€/nuit/pers — Booking uniquement)
- Résidence Al Boustane
- Agdal 13

Salé (taxe 2€/nuit/pers — Booking uniquement)
- Touahri 11
- Riad Ahl Sala

Inactif (archivé, aucun smoobu_id)
- Studio Ocean (fin janvier 2026) — 11 réservations historiques, saisie manuelle

---

COMMISSIONS (CALCUL AUTO UNIQUEMENT)

Booking.com → 22%
Airbnb → 15.5%
Direct → 0%
VRBO → 18%

⚠️ Ne jamais importer la commission depuis le fichier
⚠️ Toujours recalculer via COM[src] × brut

---

TAXE DE SÉJOUR

Booking.com UNIQUEMENT — Airbnb / Direct / VRBO = 0

Calcul :
- Rabat → 4€ × nuits_sejour × nb_personnes
- Salé → 2€ × nuits_sejour × nb_personnes

Stockée en MAD (table `taxe`). Collectée en cash terrain.
⚠️ Ne jamais inclure dans le brut EUR de la réservation

---

LOGIQUE DE DEVISE

- Toutes les réservations stockées en EUR
- AUCUNE conversion à l'import
- Conversion EUR → MAD uniquement dans dashboard (taux temps réel)

⚠️ Ne jamais utiliser un taux fixe en base

---

TYPES NORMALISÉS

Smoobu Payout → RESERVATION
Smoobu Cancelled with payout / "Cancellation Payout - EUR" → ANNULATION_PAYEE
Smoobu Cancelled (sans payout) → ANNULATION_NON_PAYEE
Smoobu AirCover → AIRCOVER
Smoobu Adjustment → AJUSTEMENT
Smoobu Relocation → RELOCATION
Direct → DIRECT

IMPACT KPI :
RESERVATION → revenu + nuits
ANNULATION_PAYEE → revenu + nuits business uniquement
ANNULATION_NON_PAYEE → ignoré (aucun KPI)
RELOCATION → revenu + nuits (identique RESERVATION)
AIRCOVER → revenu uniquement (0 nuit, encaissement ponctuel)
AJUSTEMENT → revenu uniquement (0 nuit, encaissement ponctuel)
DIRECT → revenu + nuits

---

MULTI-VERSEMENT AIRBNB

Même code = plusieurs lignes CSV
Ex : AIR-XXX (principal) + AIR-XXX-Resol + AIR-XXX-AIRC

⚠️ Ne jamais fusionner — chaque ligne = une entrée CRM distincte
⚠️ findByCode() : matche ref === code, AIR-code, code_suffix, code-suffix

---

MAPPING LOGEMENTS (noms Smoobu → noms CRM)

"Spacious 3BR / 3 chambres" → Résidence Al Boustane
"Élégant & Sécurisé Piscine" → Touahri 11
(autres mapppings à vérifier dans smoobu-normalizer.js)

---

FORMAT FINAL (record CRM complet)

{
  "id": "uid()",
  "smoobu_id": "string UNIQUE (null si non-Smoobu)",
  "ref": "AIR-xxx / BKG-xxx / DIR-xxx / VRB-xxx",
  "source": "Airbnb / Booking.com / VRBO / Direct",
  "appart": "nom officiel CRM",
  "voyageur": "nom",
  "checkin": "YYYY-MM-DD",
  "checkout": "YYYY-MM-DD",
  "nuits_sejour": 0,
  "nuits_fact": 0,
  "nuits_business": null,
  "nb_personnes": 1,
  "brut": 0,
  "com_pct": 0.155,
  "commission": 0,
  "net": 0,
  "taxe_sejour": 0,
  "type_norm": "RESERVATION",
  "statut": "Payé",
  "date_paiement": "YYYY-MM-DD",
  "mois_kpi": "YYYY-MM",
  "override_manual": false,
  "mad_reel": null,
  "taux_reel": null,
  "mad_reel_source": null,
  "mad_reel_updated_at": null,
  "notes": ""
}

⚠️ Supabase = source de vérité unique
⚠️ JSON = backup uniquement
⚠️ localStorage = ancien système
