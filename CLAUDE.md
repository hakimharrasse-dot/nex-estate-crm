# Nex-Estate CRM — Contexte projet Claude Code

> Fichier de mémoire projet pour Claude Code.  
> À lire automatiquement au démarrage de chaque conversation dans ce dossier.  
> Ne pas modifier les fichiers de code sans instruction explicite.

---

## 1. Vue d'ensemble

**Nex-Estate CRM** est un outil de gestion de réservations locatives courte durée (Airbnb, Booking.com, VRBO, Direct) pour 4 appartements au Maroc.

- **Frontend** : `index.html` unique (~5500 lignes), vanilla JS, zéro framework, zéro build
- **Backend** : Vercel Serverless Functions (Node.js)
- **Base de données** : Supabase (PostgreSQL 17, projet `zjultuaqkzjupiiewxhy`, région `eu-west-1`)
- **Source de réservations** : Smoobu (PMS) via webhook temps réel + cron horaire
- **Déploiement** : Vercel, domaine `nex-estate-seven.vercel.app`
- **Auth** : Supabase Auth (email/password), rôles `admin` / `manager` / `user`

---

## 2. Structure des fichiers

```
nex-estate-crm-tmp/
├── index.html                  ← CRM complet (frontend + logique métier)
├── vercel.json                 ← Config Vercel (fonctions + cron)
├── package.json                ← Dépendance : @supabase/supabase-js ^2.49.4
├── BACKUP_SUPABASE_SCHEMA.sql  ← Schéma SQL complet reconstituable
├── CLAUDE.md                   ← Ce fichier
├── api/
│   ├── smoobu-poll.js          ← Polling Smoobu (cron horaire + manuel)
│   ├── smoobu-webhook.js       ← Récepteur webhook Smoobu (temps réel)
│   └── admin-users.js          ← CRUD utilisateurs (admin only, service_role)
└── lib/
    └── smoobu-normalizer.js    ← Logique métier Smoobu partagée
```

---

## 3. Appartements valides (actifs)

```javascript
const APPARTS_VALIDES = [
  'Résidence Al Boustane',  // Rabat — taxe séjour 4 EUR/nuit/pers
  'Agdal 13',               // Rabat — taxe séjour 4 EUR/nuit/pers
  'Touahri 11',             // Salé  — taxe séjour 2 EUR/nuit/pers
  'Riad Ahl Sala',          // Salé  — taxe séjour 2 EUR/nuit/pers
];
```

### Logements archivés — règle métier immuable

Le CRM dispose d'une section **Logements** permettant d'activer/archiver des biens avec des dates d'exploitation.

**Studio Ocean** est un **logement historique valide**, restitué début février 2026.  
- Il a été exploité en **janvier 2026** et partiellement en **début février 2026**  
- Il **n'est PAS dans Smoobu** (archivé avant l'intégration Smoobu) → jamais de smoobu_id sur ses réservations  
- Ses 11 réservations (10 en janvier, 1 en février) ont été importées manuellement via CSV  
- Il **ne doit PAS apparaître** dans les mois suivant sa restitution (mars 2026+)  
- Il **doit rester visible** sur janvier et début février → l'occupation et le CA de ces mois l'incluent

**Règle générale — logements actifs/archivés :**
> Un appartement archivé reste visible dans l'historique CRM pour toutes les réservations **antérieures à sa date de restitution**. Il ne génère aucun warning ou erreur sur ces périodes. Il n'affecte pas les KPIs des mois **postérieurs** à sa restitution.

**Ce qu'il ne faut jamais faire :**
- Supprimer les réservations Studio Ocean de janvier/février (données financières réelles)
- Interpréter "Studio Ocean" dans un KPI de janvier comme une erreur
- Ajouter "Studio Ocean" à `APPARTS_VALIDES` (il ne doit pas être synchronisé par Smoobu)

**Données Studio Ocean (état base au 2026-05-01) :**
| Voyageur | Source | Nuits | Brut EUR | Smoobu ID |
|---|---|---|---|---|
| Madani Yaniss Rezigui | Airbnb | 2 | 181 | — |
| Mustapha Lachhab | Booking.com | 2 | 173.90 | — |
| KADI PASCALINE SOUMAHORO | Booking.com | 7 | 602.80 | — |
| Thomas Liebermann | Booking.com | 2 | 207.15 | — |
| Abdelilah Aboulfejr | Airbnb | 10 | 504.75 | — |
| Bouchra Zelmad | Airbnb | 1 | 88 | — |
| Mourad Abm | Airbnb | 1 | 86 | — |
| Jean Duclair PONE | Airbnb | 1 | 72 | — |
| Imne Hadri | Airbnb | 1 | 97 | — |
| Laurena | Direct | 4 | 400 | — |
| Fahd Boukhari | Airbnb | 1 | 57 | — |

---

## 4. Schéma Supabase — tables principales

### `resa` — réservations (table centrale)
| Colonne | Type | Notes |
|---|---|---|
| `id` | text PK | `uid()` JS côté client/API |
| `smoobu_id` | text UNIQUE | Clé déduplication Smoobu (`uq_resa_smoobu_id`) |
| `ref` | text | Référence plateforme (ex: `HMGE7KTKZW`) |
| `source` | text | `Airbnb` / `Booking.com` / `VRBO` / `Direct` |
| `appart` | text | Un des 4 appartements valides |
| `voyageur` | text | Nom du voyageur |
| `checkin` / `checkout` | text | Format `YYYY-MM-DD` |
| `nuits_sejour` | integer | Nuits réelles (0 si annulation non payée) |
| `nuits_fact` | integer | Nuits facturées |
| `nuits_business` | integer NULL | Override occupation — si NULL = calcul auto |
| `brut` | numeric | Prix brut EUR |
| `com_pct` | numeric | Commission en décimal (ex: 0.22) |
| `commission` | numeric | Montant commission EUR |
| `net` | numeric | brut - commission |
| `taxe_sejour` | numeric | Booking.com uniquement — hors CA |
| `type_norm` | text | `RESERVATION` / `ANNULATION_PAYEE` / `ANNULATION_NON_PAYEE` |
| `statut` | text | `Payé` / `En attente` / `Annulé` |
| `date_paiement` | text | Format `YYYY-MM-DD` — calculé par règle métier |
| `mois_kpi` | text | Format `YYYY-MM` — basé sur `date_paiement` |
| `override_manual` | boolean DEFAULT false | Protège les champs financiers contre l'écrasement API |
| `date_creation` | date | Date de création Smoobu |
| `phone` / `email` / `guest_language` | text | Coordonnées voyageur |
| `adults` / `children` / `nb_personnes` | integer | Composition du groupe |
| `notes` | text | Notes libres |

### Autres tables
- `business` — dépenses/revenus liés aux appartements (scope: property ou global)
- `perso` — dépenses personnelles (admin uniquement)
- `taxe` — taxe de séjour Booking.com
- `serv` — services (ménage, maintenance)
- `profiles` — utilisateurs CRM (lié à `auth.users`)
- `team_members` — équipe (ménage, maintenance)
- `recurring_charges` — charges récurrentes (loyers, abonnements)
- `resa_backup_20260426` — snapshot figé du 26 avril 2026

---

## 5. Règles métier — IMMUABLES (ne jamais modifier)

### Ce qu'il ne faut JAMAIS toucher
- **CA (Chiffre d'affaires)** et son calcul
- **`date_paiement`** et son calcul par source
- **`mois_kpi`** et son calcul (basé sur `date_paiement`, pas `checkin`)
- **KPIs** (revenus, taux d'occupation globale)
- **Design et layout général** du CRM

### Règles de date_paiement par source
```
Airbnb     → checkin + 1 jour
Booking.com → prochain jeudi après checkout
VRBO       → checkin + 7 jours
Direct     → date_creation
Annulation non payée → date_creation
```

### Règles de statut
```
ANNULATION_NON_PAYEE → statut = 'Annulé'
Autres → date_paiement <= aujourd'hui ? 'Payé' : 'En attente'
```

### Taxe de séjour
- **Booking.com uniquement** (pas Airbnb, VRBO, Direct)
- Exclue du CA (argent reversé à l'État)
- Calcul : `nuits_sejour × adultes × tauxTaxe(appart)`
- Rabat (Al Boustane, Agdal 13) : 4 EUR/nuit/pers
- Salé (Touahri 11, Riad Ahl Sala) : 2 EUR/nuit/pers

### Commission par source (fallback si non fourni par Smoobu)
```
Airbnb      : 15.5%
Booking.com : 22%
VRBO        : 18%
Direct      : 0%
```
> L'API Smoobu renvoie `commission-included` en POURCENTAGE (ex: 22.0 = 22%), à diviser par 100.

### `nuits_business`
- Champ optionnel — si NULL, l'occupation est calculée automatiquement par chevauchement de dates
- Si renseigné, remplace le calcul auto pour l'occupation (pro-raté si séjour chevauche plusieurs mois)
- Visible dans le formulaire réservation, juste après "Nuits facturées" (id: `fi-nuits-biz`)
- Préservé lors des imports CSV (`confirmCSV()`) et des syncs API partielles (`override_manual=true`)

---

## 6. Synchronisation Smoobu ✅ FONCTIONNELLE

### État actuel (testé et confirmé — 2026-04-30)
**La synchronisation Smoobu → CRM est opérationnelle à 100%.**  
Variables d'environnement Vercel configurées et testées.

### Architecture de sync (2 mécanismes)

**A. Webhook temps réel** (`/api/smoobu-webhook.js`)
- Smoobu envoie un POST instantané à chaque événement
- Actions gérées : `newReservation`, `updateReservation`, `cancelReservation`, `deleteReservation`
- `deleteReservation` → soft delete uniquement (statut=Annulé, notes+="|Deleted from Smoobu")
- Upsert sur `smoobu_id` (index UNIQUE `uq_resa_smoobu_id` requis en base ✓)
- Utilise `lib/smoobu-normalizer.js` pour la normalisation
- URL configurée dans Smoobu : Settings → Advanced → API Keys → Webhook URLs

**B. Cron polling horaire** (`/api/smoobu-poll.js`)
- Cron `0 * * * *` (toutes les heures) défini dans `vercel.json`
- Fenêtre par défaut : 25h (`POLL_WINDOW_HOURS`)
- Endpoint manuel : `GET /api/smoobu-poll?from=YYYY-MM-DD` (backfill)
- Endpoint diagnostic : `GET /api/smoobu-poll?probe=SMOOBU_ID`
- Logique 3 cas :
  - A. `smoobu_id` absent → INSERT avec `uid()`
  - B. `override_manual=true` → UPDATE partiel (dates/voyageur uniquement, finances protégées)
  - C. Else → UPDATE complet
- `remediateStragglers()` : corrige les enregistrements avec voyageur/ref vides (jusqu'à 30/run)

**C. Edge Function** (`smoobu-enrich`, Supabase)
- Enrichit les enregistrements existants avec voyageur/ref vides
- N'est PAS une fonction de sync — enrichissement uniquement
- `verify_jwt: false`, header requis : `x-enrich-token: NEX_ENRICH`

### Variables d'environnement Vercel (toutes configurées)
```
SUPABASE_URL              → https://zjultuaqkzjupiiewxhy.supabase.co
SUPABASE_SERVICE_ROLE_KEY → clé service_role
SMOOBU_API_KEY            → clé API Smoobu
CRON_SECRET               → secret optionnel (si défini, le poll exige Bearer <secret>)
POLL_WINDOW_HOURS         → 25 (par défaut)
```

---

## 7. Sécurité et RLS

- RLS activé sur toutes les tables métier
- Fonction `get_my_role()` (SECURITY DEFINER) : retourne le rôle de l'utilisateur connecté
- Rôles : `admin` > `manager` > `user`
  - `user` : lecture `resa` uniquement
  - `manager` : lecture/écriture sur `resa`, `business`, `taxe`, `serv`, `team_members`, `recurring_charges`
  - `admin` : tout + suppression + `perso` + gestion utilisateurs
- `profiles` : INSERT/UPDATE/DELETE uniquement via `/api/admin-users.js` (service_role, bypass RLS)
- Côté client JS : Supabase JS SDK avec clé `anon` (respecte RLS)
- Côté serveur (API Vercel) : `SUPABASE_SERVICE_ROLE_KEY` (bypass RLS)

---

## 8. Modules clés dans index.html

Le fichier `index.html` est organisé en sections délimitées par des commentaires `// ──`.

| Module / Fonction | Rôle |
|---|---|
| `uid()` | Génère un ID aléatoire (Date.now + random) |
| `parseSmoobuRow()` | Parse une ligne CSV Smoobu |
| `confirmCSV()` | Import CSV : upsert avec protection `override_manual` et préservation `nuits_business` |
| `showImportLog()` | Affiche le log du dernier import CSV (depuis localStorage `smoobu_import_log`) |
| `syncSmoobuAPI()` | Déclenche `/api/smoobu-poll?from=…` depuis le CRM, affiche overlay de résultat |
| `buildForm('resa', id)` | Génère le modal d'édition d'une réservation |
| `saveResa()` | Sauvegarde une réservation depuis le modal (inclut `nuits_business`) |
| `effectiveNightsInPeriod(r, pStart, pEnd)` | Calcul chevauchement nuits (utilise `nuits_business` si défini) |
| `occupNightsBiz(appart, pStart, pEnd)` | Agrège les nuits business par appartement sur une période |
| `recomputeAndSave()` | Recalcule statuts/dates de toutes les réservations |
| `calcDatePaiement()` | Règle de date paiement par source (identique à `lib/smoobu-normalizer.js`) |

### IDs importants dans le DOM
- `fi-nuits-biz` — input nuits_business dans le modal réservation
- `btn-api-sync` — bouton "⚡ Sync API"
- `btn-import-log` — bouton "📋 Log CSV"
- `api-sync-ov` — overlay résultat sync API (z-index 903)
- `import-log-ov` — overlay log CSV (z-index 902)
- `audit-occ-ov` — overlay audit occupation (z-index 901)

---

## 9. Conventions de développement

- **Pas de build** : le JS/CSS est inline dans `index.html`, pas de transpilation
- **Pas de framework** : vanilla JS ES5/ES6 mixte, `var` + `const`/`let` coexistent
- **Supabase SDK v2** côté client : `SUPA.from(TABLE).upsert(chunk, {onConflict:'id'})`
- **PostgREST natif** côté API Vercel (`sbFetch`) : pas de SDK, appels REST directs
- **`smoobu-poll.js`** : syntaxe ESM (`export default`) — Vercel compile en CJS automatiquement
- **`smoobu-webhook.js`** et **`admin-users.js`** : CJS (`module.exports`)
- **IDs CRM** : générés côté JS/API avec `uid()` = `Date.now().toString(36) + random`
- **Dates** : toujours au format `YYYY-MM-DD` (texte), jamais de Date objects en base

---

## 10. Checklist avant toute modification

- [ ] La modification touche-t-elle CA, date_paiement, mois_kpi ou les KPIs ? → **Ne pas toucher**
- [ ] La modification touche-t-elle le design général ? → **Ne pas toucher sans instruction explicite**
- [ ] La modification de `index.html` casse-t-elle `parseSmoobuRow()` ou `confirmCSV()` ? → Vérifier
- [ ] Un champ financier (`brut`, `net`, `commission`) est-il écrasé sans `override_manual=false` ? → Risque de perte de données
- [ ] L'`id` généré par `uid()` est-il bien unique (pas de collision avec `smoobu_id`) ? → Oui par design

---

## 11. Données historiques Jan/Feb/Mar 2026 — état et correction

### Problème documenté (diagnostic 2026-05-01)

Les réservations de janvier, février et mars 2026 ont été importées via **CSV groupé** avant l'intégration Smoobu. Ce mode d'import utilisait :
- `checkin = 2026-MM-01` (premier jour du mois) pour **toutes** les réservations du mois
- `checkout = ""` (vide)

**Conséquence** : `effectiveNightsInPeriod()` calcule 0 nuit pour toutes ces réservations → **occupation = 0%** sur ces mois, malgré un CA correct (basé sur `net + date_paiement`).

### Bilan quantifié (non-ANNULATION_NON_PAYEE)

| Appart | Total | Checkout manquant | Smoobu ID | Récupérable auto |
|---|---|---|---|---|
| Agdal 13 | 29 | 22 | 24 | ✅ 22 |
| Résidence Al Boustane | 45 | 28 | 34 | ⚠️ 28 (risque MAD) |
| Riad Ahl Sala | 31 | 26 | 27 | ✅ 26 |
| Studio Ocean | 11 | 11 | 0 | ❌ 0 (manuel) |
| Touahri 11 | 38 | 31 | 31 | ✅ 31 |

### Méthode de correction (ordre obligatoire)

1. **Audit finances d'abord** → corrections financières verrouillées (`override_manual=true`)
2. **Poll backfill** : `GET /api/smoobu-poll?from=2025-10-01` → restaure les vraies dates pour les 116 records avec smoobu_id
3. **Studio Ocean** : saisie manuelle des dates (11 records, aucun smoobu_id)

### Risque MAD — Résidence Al Boustane

Le CSV Smoobu affiche les prix de cet appartement **en MAD** (ex: 1207.68 MAD pour Hawraz Ako). La base CRM stocke les montants **en EUR** (112.86 EUR). **Ne jamais importer le CSV directement sans verrouillage préalable** (`override_manual=true`) pour les records Al Boustane — les montants seraient multipliés par ~10.7. Le poll API (qui retourne EUR directement) est exempt de ce risque.

### Protection triple contre l'écrasement (déployée 2026-05-01)

| Fix | Où | Quoi |
|---|---|---|
| Fix 1 | `index.html finDoApply()` | Audit finances pose `override_manual=true` automatiquement |
| Fix 2 | `api/smoobu-webhook.js` | Webhook lit `override_manual` avant tout upsert |
| Fix 3 | `api/smoobu-poll.js` | Poll ne remet jamais `override_manual=false` sur un record existant |

---

## 12. Historique récent (depuis avril 2026)

| Date | Changement |
|---|---|
| 2026-04-28 | Ajout champ `nuits_business` (colonne + formulaire + calcul occupation) |
| 2026-04-28 | Ajout `showImportLog()` + stockage log dans `localStorage` |
| 2026-04-28 | Ajout `syncSmoobuAPI()` + overlay temps réel |
| 2026-04-28 | Cron changé de `0 12 * * *` (quotidien) à `0 * * * *` (horaire) |
| 2026-04-29 | Variables Vercel configurées — sync testée et confirmée fonctionnelle |
| 2026-04-30 | Backup complet produit (`BACKUP_SUPABASE_SCHEMA.sql`) + ce fichier |
| 2026-05-01 | Règle annulation Smoobu révisée : Airbnb ANNULATION_PAYEE seulement si `price-details` contient "Cancellation Payout - EUR" |
| 2026-05-01 | Protection triple `override_manual` déployée (Fix 1 Audit finances, Fix 2 webhook, Fix 3 poll) |
| 2026-05-01 | Diagnostic Jan/Feb/Mar : 118/154 records sans checkout → 0% occupation → correction via poll backfill from=2025-10-01 |
| 2026-05-01 | Studio Ocean documenté comme logement historique valide (restitué fév 2026, non dans Smoobu) |
