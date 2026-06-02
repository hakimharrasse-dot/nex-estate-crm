# Nex-Estate CRM — Contexte projet Claude Code

> Fichier de mémoire projet pour Claude Code.  
> À lire automatiquement au démarrage de chaque conversation dans ce dossier.  
> Ne pas modifier les fichiers de code sans instruction explicite.

---

## 1. Vue d'ensemble

**Nex-Estate CRM** est un outil de gestion de réservations locatives courte durée (Airbnb, Booking.com, VRBO, Direct) pour 4 appartements au Maroc.

- **Frontend** : `index.html` unique (~11 650 lignes), vanilla JS, zéro framework, zéro build
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
│   ├── smoobu-messages.js      ← Module messagerie IA (webhook + brouillon Claude + envoi)
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
| `mad_reel` | numeric NULL | Montant net réel encaissé en MAD (Airbnb payout) — jamais écrasé par webhook/poll |
| `taux_reel` | numeric NULL | Taux EUR→MAD effectif du versement (ex: 10.8723) — null pour natif MAD |
| `mad_reel_source` | text NULL | `'CSV Airbnb payout'` / `'CSV Airbnb MAD natif'` / `'CSV Airbnb complexe / validation manuelle'` |
| `mad_reel_updated_at` | text NULL | ISO datetime de la dernière mise à jour mad_reel |

### `serv` — services additionnels (ménage, maintenance, extras voyageur)
| Colonne | Type | Notes |
|---|---|---|
| `id` | text PK | `uid()` JS côté client |
| `date` | text | Format `YYYY-MM-DD` — date du service |
| `appart` | text | Appartement concerné |
| `svc` | text | Type de service (ex: Climatisation, Ménage, Linge...) |
| `voy` | text | Nom du voyageur (optionnel) |
| `col` | text | Collecté par (membre équipe) |
| `pay` | text | Payé par (source du paiement) |
| `montant` | numeric | Montant en **MAD** |
| `statut` | text | `Payé` / `En attente` |
| `resa_ref` | text NULL | Code réservation Airbnb lié — match prioritaire réconciliation (ajouté 2026-05-31) |

### `messages` — messagerie IA (module Messages IA, ajouté 2026-05)
| Colonne | Type | Notes |
|---|---|---|
| `id` | text PK | `uid()` |
| `smoobu_booking_id` | integer | ID réservation Smoobu |
| `smoobu_message_id` | text NULL | ID message Smoobu (déduplication) |
| `sender` | text | `guest` / `host` / `system` |
| `message_content` | text | Contenu brut du message |
| `detected_language` | text NULL | Code ISO 2 lettres (ex: `fr`, `en`, `es`) |
| `client_summary_fr` | text NULL | Résumé IA en français (1-2 phrases) |
| `classification` | text NULL | `simple` / `complex` / `no_reply_needed` |
| `ai_draft` | text NULL | Brouillon de réponse dans la langue du voyageur |
| `ai_draft_fr` | text NULL | Traduction française du brouillon |
| `hakim_instruction` | text NULL | Instruction de réécriture saisie par Hakim |
| `statut` | text | `pending` / `sent` / `treated` / `error` |
| `is_stale` | boolean | Brouillon obsolète (message Smoobu plus récent détecté) |
| `error_message` | text NULL | Message d'erreur si `statut=error` |
| `raw_payload` | jsonb NULL | Payload webhook brut (debug) |
| `created_at` / `updated_at` | text | ISO datetime |

### Autres tables
- `business` — dépenses/revenus liés aux appartements (scope: property ou global)
- `perso` — dépenses personnelles (admin uniquement)
- `taxe` — taxe de séjour Booking.com
- `profiles` — utilisateurs CRM (lié à `auth.users`)
- `team_members` — équipe (ménage, maintenance)
- `recurring_charges` — charges récurrentes (loyers, abonnements)
- `logements` — appartements actifs/archivés (RLS activé 2026-05-06) — colonnes : id, nom, nom_smoobu, ville, actif, date_debut, date_fin, notes, created_at
- `resa_backup_20260426` — snapshot figé du 26 avril 2026 (RLS admin-only 2026-05-06)
- `resa_backup_20260430` — snapshot figé du 30 avril 2026 (RLS admin-only 2026-05-06)

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
Airbnb RESERVATION / ANNULATION_PAYEE / RELOCATION → checkin + 1 jour
Airbnb AIRCOVER / AJUSTEMENT → saisie manuelle uniquement (jamais recalculée)
Booking.com → prochain jeudi après checkout
VRBO       → checkin + 7 jours
Direct     → date_creation
Annulation non payée → date_creation
```
> AIRCOVER et AJUSTEMENT Airbnb peuvent être encaissés plusieurs jours après le séjour (remboursement AirCover tardif, demande d'argent acceptée, ajustement après coup).
> `calcDatePaiement` retourne `null` pour ces types. `autoCalcDP()` ne touche pas `fi-dp`. `saveResa()` lit `fi-dp` directement. `recomputeAllPaymentDates()` conserve la date existante.

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
ANTHROPIC_API_KEY         → clé Claude API (module Messages IA — côté serveur uniquement)
CRON_SECRET               → secret optionnel (si défini, le poll exige Bearer <secret>)
POLL_WINDOW_HOURS         → 25 (par défaut)
```

---

## 7. Sécurité et RLS

- RLS activé sur toutes les tables métier (y compris `logements`, `resa_backup_20260426`, `resa_backup_20260430` — ajouté 2026-05-06)
- Fonction `get_my_role()` (SECURITY DEFINER) : retourne le rôle de l'utilisateur connecté
  - EXECUTE révoqué de PUBLIC et du rôle `anon` (2026-05-06) — uniquement `authenticated`
- Rôles : `admin` > `manager` > `user`
  - `user` : lecture `resa` uniquement
  - `manager` : lecture/écriture sur `resa`, `business`, `taxe`, `serv`, `team_members`, `recurring_charges`, `logements`
  - `admin` : tout + suppression + `perso` + gestion utilisateurs + lecture `resa_backup_*`
- `profiles` : INSERT/UPDATE/DELETE uniquement via `/api/admin-users.js` (service_role, bypass RLS)
- `resa_backup_*` : SELECT admin uniquement, aucune écriture possible
- Vue `v_logements_actifs_par_mois` : recrée avec `security_invoker=true` (2026-05-06) — respecte le RLS de `logements`
- Côté client JS : Supabase JS SDK avec clé `anon`/publishable `sb_publishable_...` (respecte RLS)
- Côté serveur (API Vercel) : `SUPABASE_SERVICE_ROLE_KEY` (bypass RLS) — jamais exposée côté frontend

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
| `filterPer(rows, k)` | Filtre universel par période — clés : `r, b, t, s, p, d, gn` |
| `setPer(k, p)` | Active une période pour une clé — met à jour l'onglet actif |
| `renderNav(k)` | Génère la barre de navigation dates pour la clé donnée |
| `renderBiz()` | Rendu liste Dépenses Business avec filtres b-fap/b-fcat/b-fmen/b-fst/b-fpay/b-fsearch |
| `populateTeamSelects()` | Peuple b-fmen (toute l'équipe active), b-fpay (équipe + historique paid_by), t-fcol, s-fcol |
| `renderWkCards()` | Récap équipe : cartes avec gains, avances, dépenses, solde net — modes cumul/semaine/mois/perso |
| `renderGainsCards()` | Gains ménage par membre — filterPer sur clé 'gn' (période indépendante) |
| `getSoldeData(name)` | Calcule bizIds/taxeIds/servIds + men/adv/tax/ext/net pour la modale Solder |
| `confirmSolde()` | Exécute le règlement : ①bizPend→Payé + neutralise paid_by, ②taxe→Reversé, ③serv→Payé, ④crée Règlement terrain |
| `parseAirbnbCSV(text, taux)` | Parse le CSV paiements Airbnb → `{ reservations[], resolutions[] }`. Pre-pass lie les Payout MAD aux transactions individuelles. |
| `buildMadRealRows(parsed, taux)` | Construit `MAD_REEL_ROWS` à partir du CSV parsé — appelle `addRow` pour chaque ligne éligible |
| `addRow(csvRow, payoutMAD)` | Cœur du module — applique les guards (TYPES_OK, natif MAD, ambiguïté, net mismatch) et pousse dans MAD_REEL_ROWS |
| `renderMadRealSection()` | Rendu UI de la section MAD réel Airbnb (onglet Réconciliation) |
| `applyMadReal()` | Batch auto-apply sur les lignes simples cochées (taux dans plage, pas USD, pas régul, pas mismatch) |
| `applyMadRealManual(crmId)` | Validation manuelle unitaire — guards EUR-au-lieu-de-MAD (×100) et val < ref×0.5 |
| `madReelIgnore(crmId)` | Ajoute à `nex_madReel_ignored_v1` (localStorage), retire de MAD_REEL_ROWS |
| `rNetMAD(r)` | Helper dashboard : retourne `r.mad_reel` si éligible, sinon `r.net × EUR_MAD` |
| `rBrutMAD(r)` | Helper dashboard : `r.brut × r.taux_reel` si éligible, sinon `r.brut × EUR_MAD` |
| `rComMAD(r)` | Helper dashboard : `r.commission × r.taux_reel` si éligible, sinon `r.commission × EUR_MAD` |
| `sumNetMAD(rows)` | Somme MAD nette d'un tableau via `rNetMAD` — utilisé dans computePeriodKPIs, renderDash, renderResa |
| `handleBkCSV(inp)` | Import CSV Booking global (ISO-8859-1) → parse, groupe par batch, construit anomalies + manquantes |
| `bkParseCSV(text)` | Parse le CSV versements Booking : colonnes positionnelles + fallback nom (encodage robuste) |
| `bkParseFrDate(str)` | Convertit "1 janv. 2026" → "2026-01-01" (mapping mois FR abrégés ISO-8859-1) |
| `bkFindCRM(numRef)` | Cherche dans DB.resa les Booking.com dont `ref` = numRef CSV |
| `handleBkPDF(inp, bi)` | Upload PDF par batch → charge PDF.js CDN lazy → extrait MAD/taux via `bkParsePDFText` |
| `bkParsePDFText(text, batch)` | Regex sur texte PDF.js : taux de change, MAD total versé, ID paiement, cross-check refs |
| `applyBkBatch(bi)` | Batch PATCH Supabase : mad_reel=net×taux, taux_reel, mad_reel_source='booking_pdf' — avec guards |
| `renderBkSection()` | Rendu principal Booking : onglets, badges, dispatch anomalies/batches/manquantes |
| `renderBkBatches()` | Rendu des cartes batch avec état eur_only/pdf_ready/applied, upload PDF, bouton Appliquer |
| `renderBkAnom()` | Rendu anomalies EUR (écart CSV↔CRM > 0.50 EUR) avec ignorer/remettre persistant |
| `renderBkMiss()` | Rendu lignes CSV absentes du CRM avec ignorer/remettre persistant |
| `buildServResaOptions()` | Génère les `<option>` pour le datalist resa_ref : 80 dernières réservations Airbnb (ref, voyageur, checkin) |
| `saveServ()` | Sauvegarde un service additionnel — inclut `resa_ref` (optionnel, trimé, null si vide) |
| `findServMatch(csv)` | Matching CSV Airbnb ↔ serv — P0 : resa_ref exact ; fuzzy : montant ±5% + date ±15j + voyageur accent-normalisé |
| `renderMissingSection()` | Lignes manquantes — section verte "Déjà dans serv" (checkId='A_SERV') distincte des lignes rouges |
| `renderMessages()` | Rendu principal module Messages IA — liste des threads, badges, filtres |
| `loadMessages()` | Charge les messages depuis Supabase table `messages`, trie par date |
| `openMessageThread(id)` | Ouvre le modal d'un thread — affiche conversation, brouillon IA, traduction FR |
| `regenerateDraft(id)` | POST `/api/smoobu-messages?regenerate=1` — regénère le brouillon avec instruction Hakim |
| `sendMessage(id)` | POST `/api/smoobu-messages?send=1` — envoie le brouillon validé (jamais auto) |
| `markTreated(id)` | PATCH `messages` → `statut=treated` — marque comme Traité sans envoi |
| `syncMessagesNow()` | Déclenche un sync Smoobu backend réel via POST `/api/smoobu-messages?sync=1` |

### Variables globales d'état des périodes (lignes ~2550-2558)
```javascript
var P   = {r:'mois',b:'mois',t:'mois',s:'mois',p:'mois',d:'mois',gn:'mois'};
var DAY = {r:today(),b:today(),...,gn:today()};
var WK  = {r:today(),b:today(),...,gn:today()};
var MO  = {r:new Date(),b:new Date(),...,gn:new Date()};
var YR  = {r:new Date().getFullYear(),...,gn:new Date().getFullYear()};
var CUSTOM_FROM = {r:'',b:'',t:'',s:'',p:'',d:'',gn:''};
var CUSTOM_TO   = {r:'',b:'',t:'',s:'',p:'',d:'',gn:''};
var WK_MODE = 'cumul';    // default: 📋 En cours (tout ouvert, sans limite de date)
```

### IDs importants dans le DOM
- `fi-nuits-biz` — input nuits_business dans le modal réservation
- `btn-api-sync` — bouton "⚡ Sync API"
- `btn-import-log` — bouton "📋 Log CSV"
- `api-sync-ov` — overlay résultat sync API (z-index 903)
- `import-log-ov` — overlay log CSV (z-index 902)
- `audit-occ-ov` — overlay audit occupation (z-index 901)
- `b-fmen` — filtre membre (toute l'équipe active)
- `b-fpay` — filtre payeur strict (paid_by)
- `b-fsearch` — recherche libre "Lié à" (paid_by + fmen + desc)
- `b-fcat` — filtre catégorie (CATS_B complet)
- `wmt-cumul` — bouton "📋 En cours" (WK_MODE=cumul, défaut)
- `gn-nav` — barre navigation Gains ménage (clé 'gn')

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
| 2026-05-02 | Feat: Solder personne — règlement net par période avec Règlement terrain (`b938678`) |
| 2026-05-03 | Fix: avance caisse Reçu/Utilisé filtrés sur `statut=Payé` uniquement — corrige comptage En attente (`a292eca`) |
| 2026-05-03 | Feat: filtre `b-fpay` "Tous payeurs" strict sur `paid_by` dans Dépenses Business (`d920305`) |
| 2026-05-03 | Fix: `bizPeriod` exclut Règlement terrain (anti double-comptage dashboard cash) ; ajout `b-fsearch` "🔍 Lié à" ; `bPend` exclut Règlement terrain (`da1adc9`) |
| 2026-05-03 | Feat: détail "Utilisé" dépliable par membre dans Récap équipe + Solde global réel (`2d62dd2`) |
| 2026-05-03 | Fix CRITIQUE: neutralisation `paid_by` sur ménages soldés via Règlement terrain — élimine le double-comptage (`751fe73`) |
| 2026-05-04 | Feat: b-fmen "Toute l'équipe" (tous membres actifs) ; gains ménage période indépendante (clé 'gn') ; WK_MODE='cumul' "📋 En cours" par défaut (`ac692b1`) |
| 2026-05-04 | Fix: `paid_by` affiché comme badge bleu 💳 dans les cartes Business mobiles (`384e40f`) |
| 2026-05-04 | Backup `nex-estate-crm-backup-2026-05-04` produit — suppression ancien backup 2026-05-02 |
| 2026-05-05 | Fix: override_manual guards F1–F3 — softDeleteResa bloqué, downgrade ANNULATION_*/AIRCOVER→RESERVATION bloqué côté webhook et poll (`4e9e8fe`) |
| 2026-05-05 | Fix: formulaire réservation — buildForm lit rec.com_pct, guard ZERO_COM_TYPES=['AIRCOVER','AJUSTEMENT'] dans saveResa (`c181acd`) |
| 2026-05-05 | Fix: commissions — ignorer commission-included Smoobu dans les 3 chemins (normalizer, parseSmoobuRow, mapSmoobuBooking) ; toujours COM[src] (`9ccc3fb`, `94aab26`) |
| 2026-05-05 | Fix: classifyFinRow — Booking.com/VRBO/ANNULATION_PAYEE → 'review' (pas 'risky') si écart ≤ 100 EUR |
| 2026-05-06 | Audit ANNULATION_NON_PAYEE — confirmé exclu de tous KPIs (CA, cash, résultat, occupation, ADR, RevPAN, Audit finances) |
| 2026-05-06 | Backup `nex-estate-crm-backup-2026-05-06` produit — suppression ancien backup 2026-05-04 |
| 2026-05-06 | Sécurité : RLS activé sur `logements`, `resa_backup_20260426`, `resa_backup_20260430` — vue `v_logements_actifs_par_mois` recrée en `security_invoker=true` — EXECUTE `get_my_role()` révoqué de PUBLIC/anon |
| 2026-05-06 | Feat: Don / pourboire dans Dépenses Perso — colonne `don` ajoutée à `perso`, checkbox dans le formulaire, badge 💝 dans l'affichage, cumul dans "Dons / Aides" du récap |
| 2026-05-10 | Fix(recompute): recomputeAndSave() PATCH ciblé (date_paiement/mois_kpi/statut/nb_personnes) au lieu d'upsert complet — commit `b43b075` |
| 2026-05-10 | Fix(recompute): nextThursday() UTC-safe dans index.html + guard Booking.com dp — parité exacte Recalculer ↔ Contrôle qualité — commit `ad5e6fd` |
| 2026-05-10 | Fix(recompute): nb_personnes = adults + children corrigé via bouton Recalculer — commit `2da4d7f` |
| 2026-05-10 | Fix(poll): empêcher sync Smoobu de ré-introduire anomalies QA — nextThursday() UTC-safe dans poll + normalizer, calcDatePaiement Booking.com sans fallback dateCreation, guards checkout vide + dp dans tous les cas (B/C-NORMAL/C-DATESONLY/C-DOWNGRADE) — commit `2a84592` |
| 2026-05-10 | Backup `nex-estate-crm-backup-2026-05-10` produit — suppression ancien backup 2026-05-06 |
| 2026-05-12 | Stabilisation module Réconciliation Airbnb CSV — commit `60c2290` (baseline backup) |
| 2026-05-13 | Fix(mad-reel): pre-fill input natif MAD corrigé — utilise `_rawLines` sum, pas `row.madReel` (`d47ef1c`) |
| 2026-05-13 | Fix(mad-natif): guard type RESERVATION strict pour natifs MAD + `_natifForceComplex` si ambiguïté (`ccc910f`) |
| 2026-05-13 | UX(mad-reel): bouton "Ignorer ce cas complexe" + confirmation avant masquage (`1adbbf4`) |
| 2026-05-13 | Fix(mad-reel): TYPES_OK restreint à RESERVATION+ANNULATION_PAYEE ; guard `_hasNetMismatch` ajouté (`e3cdf17`) |
| 2026-05-13 | DB cleanup: HMYNCCSARK-Resol — mad_reel/taux_reel/mad_reel_source/mad_reel_updated_at → NULL (AJUSTEMENT contamination) |
| 2026-05-13 | DB cleanup: HMHBWXF55D × 3 lignes (Stella) — mad_reel nullé (auto-apply erroné sur RESERVATION + 2 AJUSTEMENT) |
| 2026-05-14 | Feat(mad-reel): RELOCATION ajouté dans TYPES_OK — financièrement identique à RESERVATION côté Airbnb (`37cb5d6`) |
| 2026-05-17 | DB cleanup: 12 records AIRCOVER/AJUSTEMENT — mad_reel/taux_reel/mad_reel_source/mad_reel_updated_at → NULL (écriture ancienne, avant restriction TYPES_OK) |
| 2026-05-17 | Feat(dashboard): helpers rNetMAD/rBrutMAD/rComMAD/sumNetMAD — KPIs dashboard et renderResa utilisent mad_reel/taux_reel quand disponibles, fallback EUR×EUR_MAD (`11d31da`) |
| 2026-05-17 | Backup `nex-estate-crm-backup-2026-05-17` produit — suppression ancien backup 2026-05-12 |
| 2026-05-18 | Feat: module Réconciliation Booking — CSV global (UTF-8 double-encodé) + PDF par batch → mad_reel/taux_reel/mad_reel_source='booking_pdf' — section indépendante dans vw-reconcil, sans toucher Airbnb |
| 2026-05-18 | Feat(booking): matching robuste — BKG- prefix, double-encodage NBSP/accents, toLowerCase bug, fallback fuzzy voyageur+date/montant, 7 niveaux de matching |
| 2026-05-18 | Feat(booking): persistance état applied — auto-détection batches déjà appliqués depuis mad_reel CRM au rechargement CSV |
| 2026-05-18 | Feat(booking): rattachement manuel — lien localStorage numRef→crmId pour lignes CSV sans match automatique (`e799374`) |
| 2026-05-18 | Feat(booking): Aligner sur CSV — bouton 📐 sur anomalies EUR, patch brut/commission/com_pct/net + override_manual=true (`70d0b2e`) |
| 2026-05-18 | Fix(resa): tooltip MAD réel distingue "MAD réel Airbnb" vs "MAD réel Booking" selon r.source |
| 2026-05-18 | **STABLE** : module Réconciliation Booking clôturé — CSV = vérité EUR, PDF = vérité MAD/taux, 4 logements réconciliés |
| 2026-05-18 | Backup `nex-estate-crm-backup-2026-05-18-booking-stable` produit — suppression ancien backup 2026-05-17 |
| 2026-05-21 | Feat(dashboard): vue CA consommé par nuits — `sumCaConsomme(pStart, pEnd, appart, source)` proratise `rNetMAD(r)` par `overlap/totalNights` ; mode 2 affichage dashboard (`791644b`, `130371f`) |
| 2026-05-22 | Fix(dashboard): `computeJoursDispo(pStart, pEnd)` — corrige dénominateur taux occupation pour périodes multi-mois/custom ; Studio Ocean archivé compte 31j en janvier seulement, pas toute la période (`8b28047`) |
| 2026-05-22 | Feat(doublons): Règle R5 doublons techniques — R5a (orphelin smoobu_id=null + même ref/appart/checkin) + R5b (même smoobu_id types mixtes) ; section orange séparée ; badge KPI ; `toggleDupTechAll()` ; sans impact KPIs financiers (`4d36171`) |
| 2026-05-22 | Fix(sync): orphan fallback dans webhook (`upsertResa`) et poll (cas A) — si aucun match par smoobu_id → cherche ref+appart+checkin+smoobu_id=null → PATCH smoobu_id au lieu de créer doublon ; protège override_manual (`4d36171`) |
| 2026-05-22 | Backup `nex-estate-crm-backup-2026-05-22` produit — suppression ancien backup 2026-05-18-booking-stable |
| 2026-05-22/31 | Feat(messages-ia): module messagerie IA Smoobu complet — `api/smoobu-messages.js` : webhook newMessage → analyse Claude API → brouillon + traduction FR ; UI CRM section Messages IA (admin only) ; cron sync threads 8h ; badge Prospect ; dictée vocale Web Speech API (`8e9f76f`→`125cdde`) |
| 2026-05-22/31 | Fix(messages): nombreuses itérations — isGuestMessage() robuste, tri chronologique Smoobu, stale 48h auto-expire, host-already-replied detection, envoi bloqué si stale, Booking.com scan, send endpoint corrigé, mode IA manuel, sentHistory guard 405 (`9414c81`→`125cdde`) |
| 2026-05-31 | Feat(reconcil): ignorer les virements CSV déjà dans `serv` — `findServMatch()` : montant MAD ±5% + date ±15j + voyageur fuzzy → checkId='A_SERV' (vert) au lieu de rouge (`dcfe3e3`) |
| 2026-05-31 | Fix(reconcil): étendre `findServMatch` aux versements résolution (Check D) — AirCover/résolutions désormais reconciliés contre `serv` comme les réservations (`30d11f1`) |
| 2026-05-31 | Fix(reconcil): accents + date checkin pour résolutions — `_normStr()` (é/ñ/ç→ASCII) dans voyageur fuzzy ; Check D utilise `crmBase.checkin` (date séjour) au lieu de `res.date` (date payout, +2-4 semaines) (`341c365`) |
| 2026-05-31 | Feat(serv): champ `resa_ref` — input datalist dans le formulaire services additionnels ; `saveServ()` inclut resa_ref ; `findServMatch()` Priority 0 : resa_ref exact → match 100% fiable ; migration Supabase : `ALTER TABLE serv ADD COLUMN IF NOT EXISTS resa_ref TEXT` (`1caabe8`) |
| 2026-05-31 | **STABLE** : réconciliation serv + resa_ref opérationnelle — commit `1caabe8` (HEAD) |

---

## 13. Règles métier Avance caisse / Solder / Équipe (validées 2026-05-04)

### Architecture Avance caisse

- **Reçu** (`avances`) = entrées `cat=Avance caisse`, `fmen=membre`, `statut=Payé` — cash remis au membre
- **Utilisé** (`depMenage + depNonMen`) = toutes dépenses réelles `statut=Payé` imputées au membre — cash dépensé
  - `depMenage` : `cat=Ménage`, `(paid_by || fmen) === name`, `statut=Payé`
  - `depNonMen` : `cat !== Ménage && cat !== Avance caisse`, `fmen === name`, `statut=Payé`
- **Collecté terrain** = taxe séjour + extras collectés
- **Solde net** = Reçu + Collecté terrain − Utilisé
- **⚠️ JAMAIS filtrer sans `statut=Payé`** — les entrées "En attente" ne sont pas du cash réel

### Catégories CATS_B (complètes)
```javascript
var CATS_B = ['Ménage','Loyer','Eau & Électricité','Internet / Fibre','Frais de syndic',
  'Consommables','Technicien','Intervention','Maintenance','Ameublement / Décoration',
  'Travaux / Rénovation','Assurance','Frais bancaires','Transport / déplacements',
  'Outils / logiciels','Avance caisse','Règlement terrain','Autre'];
```

### Exclusions KPI (IMMUABLES)

| Catégorie | bizRows (Dashboard KPI) | bizPeriod (Cash dashboard) | bPend (En attente) |
|---|---|---|---|
| `Avance caisse` | ❌ Exclu | ❌ Exclu | ❌ Exclu |
| `Règlement terrain` | ❌ Exclu | ❌ Exclu | ❌ Exclu |

> `bizRows` et `bizPeriod` excluent les deux — jamais de double-comptage dans les KPIs financiers.

### Flux Solder personne (`confirmSolde()`)

1. **① Dépenses business pendantes → Payé**
   - `bizIds` → `statut = 'Payé'`
   - Si `payeur !== 'Hakim'` ET `cat === 'Ménage'` ET `paid_by === payeur` → **`paid_by = null`** (neutralisation anti-double-comptage)
2. **② Taxe de séjour → Reversé** (`taxeIds`)
3. **③ Services → Payé** (`servIds`)
4. **④ Crée "Règlement terrain"** (si `payeur !== 'Hakim'`) — montant = net, `cat='Règlement terrain'`, `fmen=payeur`, `statut='Payé'`

> **Règle critique** : le Règlement terrain représente le cash réel versé. Sans neutralisation du `paid_by` sur les ménages couverts, les ménages seraient comptés UNE FOIS via `depMenage` ET UNE FOIS via le RT dans `depNonMen`.

### Filtres Dépenses Business

| ID | Label | Logique |
|---|---|---|
| `b-fap` | Appartement | `r.appart === fa` |
| `b-fcat` | Catégorie | `r.cat === fc` — CATS_B complet |
| `b-fmen` | Membre | `r.fmen === fm` — toute l'équipe active (pas seulement ménage) |
| `b-fst` | Statut | `r.statut === fs` |
| `b-fpay` | Payé par | `r.paid_by === fp` — strict, membres actifs + historique |
| `b-fsearch` | 🔍 Lié à | texte libre sur `paid_by + fmen + desc` (audit) |

### Mode Récap équipe (WK_MODE)

| Mode | ID bouton | Comportement |
|---|---|---|
| `'cumul'` | `wmt-cumul` | **Défaut "📋 En cours"** — tout ouvert, sans limite de date |
| `'semaine'` | `wmt-semaine` | Semaine en cours |
| `'mois'` | `wmt-mois` | Mois en cours |
| `'perso'` | `wmt-perso` | Période libre |

### Gains ménage (clé 'gn')

- Filtre période **indépendant** des Dépenses Business (clé séparée `'gn'`)
- Système `filterPer/setPer` standard — onglets : Jour / Semaine / Mois / Année / Période / Cumulé
- Navigation : `id="gn-nav"`, onglets : `gnj, gns, gnm, gna, gncu, gncum`
- `tabMap` inclut `gn:'gn'`, `onCls` inclut `gn:'ong'`

### Mobile

- Cartes Business : `paid_by` affiché comme badge bleu 💳 dans `row2`
- Logique : `isMobile()` = `window.innerWidth < 700`

---

## 14. Module Réconciliation Airbnb — Règles métier (stabilisé 2026-06-02)

### airbnbBaseRef() — règle de matching durable (IMMUABLE)

```javascript
function airbnbBaseRef(code) {
  if (!code) return '';
  var c = String(code).toUpperCase().replace(/^AIR-/, '');
  var sep = c.search(/[-_]/);
  return sep > 0 ? c.slice(0, sep) : c;
}
```

Toute comparaison de référence Airbnb utilise cette fonction. Strip préfixe `AIR-` + tout suffixe après `-` ou `_`.
Guard : `baseRef.length >= 6` dans `findByCode` / `findCrmByCode`.
Appliquée dans : `findByCode`, `findCrmByCode`, `findServMatch` P0, LOT display.

### TYPES_OK (IMMUABLE)

```javascript
var TYPES_OK = ['RESERVATION', 'ANNULATION_PAYEE', 'RELOCATION'];
// AIRCOVER, AJUSTEMENT → jamais écrits, toujours fallback EUR × EUR_MAD
```

Ne jamais élargir sans décision explicite. AIRCOVER/AJUSTEMENT : `mad_reel = NULL`, `rNetMAD()` → `net × EUR_MAD`.

### Correction EUR CRM (`_hasNetMismatch`)

Si `|crm.net − csv.net| > 1 €` → complexe. Checkbox "Corriger l'EUR CRM" cochée par défaut.
Si validée : PATCH avec règles Airbnb 15,5% + `override_manual = true`. `taux_reel` calculé sur `csv.net`.

### Groupement LOT — virements Airbnb multi-lignes

| Champ | Contenu |
|---|---|
| `_batchId` | Identifiant unique du virement (pré-passe `parseAirbnbCSV`) |
| `_batchNetEUR` | Net réel = Σ positives + Σ négatives → taux lot exact |
| `_batchNegLines` | Lignes EUR négatives (déductions, rouge, non enregistrables) |
| `_batchPosLines` | Toutes lignes EUR positives du lot |

Note de réconciliation : `Σ(appariées) + Σ(non appariées +) + Σ(déductions) = payout ✓`

### Classification des lignes non appariées dans le LOT

| Cas | Condition | Affichage | Action |
|---|---|---|---|
| **Cas 1** | `airbnbBaseRef` trouve `DB.resa` (tous types) | Bleu — "présent CRM · type_norm · non éligible mad_reel" | Bouton ✏️ ouvre fiche (admin) |
| **Cas 1b** | `airbnbBaseRef` trouve `DB.serv` via `resa_ref` | Bleu — "✓ déjà dans serv" | Affichage seul |
| **Cas 2** | Aucune correspondance | Orange — "⚠️ absente du CRM → Lignes manquantes" | Renvoi Check A |

### findServMatch — priorités (MAJ 2026-06-02)

- **P0** : `serv.resa_ref` comparé par `airbnbBaseRef` (couvre les suffixes)
- **Fuzzy** : montant MAD ±5% + date ±15j + voyageur accent-normalisé
- Si `resa_ref` présent mais dossier différent → skip (pas de fuzzy fallback)

### Règle absolue : aucune application automatique

Lignes simples → bouton "Appliquer". LOT → "Valider tout le lot" + confirmation. Manuel → "Enregistrer" + confirmation + guards. Correction EUR → checkbox décochable.

---

## 14b. Module MAD réel Airbnb — Architecture complète (stabilisé 2026-05-17, MAJ 2026-06-02)

### Objectif

Réconcilier les versements Airbnb en MAD (CSV paiements Airbnb) avec les réservations CRM stockées en EUR, pour afficher et stocker le vrai montant encaissé en MAD.

### Champs DB (table `resa`)

| Champ | Contenu |
|---|---|
| `mad_reel` | Montant net MAD réellement encaissé |
| `taux_reel` | Taux EUR→MAD du versement (null si natif MAD) |
| `mad_reel_source` | Origine : `'CSV Airbnb payout'` / `'CSV Airbnb MAD natif'` / `'CSV Airbnb complexe / validation manuelle'` |
| `mad_reel_updated_at` | ISO datetime |

**Règle immuable** : ces champs ne sont JAMAIS écrits par webhook, poll Smoobu ou import CSV Smoobu. Ils sont écrits uniquement par le module MAD réel (validation manuelle ou batch).

### TYPES_OK — types éligibles à l'écriture automatique

```javascript
var TYPES_OK = ['RESERVATION', 'ANNULATION_PAYEE', 'RELOCATION'];
// AIRCOVER, AJUSTEMENT, RESOLUTION → jamais écrits par le module
```

`RELOCATION` = réservation relogée, financièrement identique à `RESERVATION` côté Airbnb.

### Guards dans `addRow()` (ordre d'application)

1. **TYPES_OK** : `crm.type_norm` doit être dans la liste → sinon ignoré
2. **Natif MAD** (`_isNativeMad`) : filter strict `type_norm === 'RESERVATION'` uniquement + `findByCode` via startsWith bloqué pour éviter contamination -Resol / -AIRC
3. **`_natifForceComplex`** : plusieurs RESERVATION pour le même code → complexe manuel
4. **`_hasNetMismatch`** : `|crm.net - csvRow.net| > 1 EUR` → complexe, jamais auto-apply
5. **`isSimpleRow`** : `batchRate ∈ [tauMin, tauMax]` ET pas `_hasUSD` ET pas `_hasNegativeRegul` ET pas `_hasRegulResol`

### `findByCode(code)` — correspondance ref Airbnb (bidirectionnelle depuis 2026-06-02)

Utilise `airbnbBaseRef()` pour le matching bidirectionnel :
- Correspondances directes : `ref === c`, `ref.startsWith(c + '-')`, etc. (historique)
- **Nouveau** : `airbnbBaseRef(ref) === airbnbBaseRef(c)` si `baseRef.length >= 6`
- Ex. : CSV `"HMR5WHAT93-Extra"` ↔ CRM `"HMR5WHAT93"` → même dossier

### Sections UI (onglet Réconciliation) — état 2026-06-02

| Section | Condition |
|---|---|
| **Lignes simples** | `isSimpleRow()` → coché auto, apply batch |
| **À valider (natif MAD)** | `_isNativeMad` → input pré-rempli avec `_natifRef` |
| **Cas complexes individuels** | `_hasNetMismatch` / `_hasRegulResol` / `_hasUSD` / `_hasNegativeRegul` / `_natifForceComplex` + batchId unique ou nul |
| **📦 Carte LOT** | ≥2 lignes complexes partageant le même `_batchId` → tableau compact, MAD proposé au taux réel, lignes positives non appariées classifiées, note réconciliation |

### Guards `applyMadRealManual(crmId)` (validation manuelle)

1. **EUR-au-lieu-de-MAD** : si `|val × 100 - ref| / ref < 5%` → confirmation "valeur semble être en EUR"
2. **Valeur trop basse** : si `val < ref × 0.5` → confirmation "très inférieur au MAD natif détecté"

### Ignore persistant

- Clé localStorage : `nex_madReel_ignored_v1` (`{ [crmId]: true }`)
- `madReelIgnore(crmId)` → ajoute + retire de `MAD_REEL_ROWS`
- Rechargé à chaque `buildMadRealRows` via `applyPersistedIgnoresMAD()`

### Helpers dashboard (ajoutés 2026-05-17)

```javascript
var MAD_REEL_ELIGIBLE = ['RESERVATION','ANNULATION_PAYEE','RELOCATION'];
function rNetMAD(r)  { return r.mad_reel != null && MAD_REEL_ELIGIBLE.indexOf(r.type_norm)>=0 ? r.mad_reel : (r.net||0)*EUR_MAD; }
function rBrutMAD(r) { return r.taux_reel != null && MAD_REEL_ELIGIBLE.indexOf(r.type_norm)>=0 ? (r.brut||0)*r.taux_reel : (r.brut||0)*EUR_MAD; }
function rComMAD(r)  { return r.taux_reel != null && MAD_REEL_ELIGIBLE.indexOf(r.type_norm)>=0 ? (r.commission||0)*r.taux_reel : (r.commission||0)*EUR_MAD; }
function sumNetMAD(rows) { return rows.reduce(function(s,r){ return s+rNetMAD(r); },0); }
```

Utilisés dans : `computePeriodKPIs` (netMad, netMadAtt), `renderDash` (brut, com, sparklines, recap appart/source, décisions rapides), `renderResa` (totaux entête, ADR, recap par appart).

### Règle d'affichage — ne JAMAIS modifier

- `net / brut / commission` en base = toujours EUR → **jamais touchés**
- `e2m()` / `fmtE()` = fonctions globales EUR×EUR_MAD → **inchangées**, utilisées pour Booking.com / VRBO / Direct / AIRCOVER / AJUSTEMENT
- AIRCOVER et AJUSTEMENT : toujours fallback EUR×EUR_MAD, `mad_reel` = NULL en base

### CSV Airbnb — format attendu

- Séparateur : virgule, encodage UTF-8
- Nombres : format français (`3 537,17` = espace milliers, virgule décimale) → `_parseNum()`
- Devises : EUR (standard) ou MAD (`_isNativeMad = csvRow.devise === 'MAD'`)
- Payout rows : type = `'Payout'`, ne doivent jamais entrer dans le traitement individuel → guard `_ptyp !== 'Payout'`

### Décisions stratégiques (2026-05-13)

- **26 versements de résolution** dans le CSV Jan–Avr 2026 : **pas automatisés** — trop complexes, validation manuelle uniquement
- **Cas complexes** (`_hasNetMismatch`, régularisation, USD, natif ambigu) : bouton "Ignorer ce cas complexe" avec confirmation → masqué définitivement


---

## 15. Module MAD réel Booking — Architecture (stabilisé 2026-05-18)

### Objectif

Réconcilier les versements Booking.com (CSV global + PDF par batch) avec les réservations CRM pour stocker le vrai montant MAD encaissé.

### Principe en 2 étapes

1. **CSV global** (`Informations de versement` → Booking Comptabilité) — encodage ISO-8859-1
   - Colonnes clés : `Numéro de référence` (jointure CRM via `r.ref`), `Net` EUR, `Identifiant du paiement` (batch CSV), `Date du paiement`
   - Tous les montants sont en EUR — pas de MAD dans le CSV
2. **PDF par batch** (`Relevé du paiement`) — upload manuel un par un
   - Contient : taux de change exact (6 décimales), MAD total versé, ID numérique PDF (≠ batch ID CSV)
   - Matching CSV↔PDF : par `Date du paiement` + `total net EUR` (les deux IDs sont différents)

### Attention : IDs de batch différents entre CSV et PDF

| Source | Identifiant du paiement | Format |
|---|---|---|
| CSV | `vQRWNPw4Ec4IaMdr` | Alphanumérique |
| PDF | `010739794924` | Numérique 12 chiffres |

Le matching est fait implicitement : l'utilisateur uploade le PDF **sur la carte du batch CSV correspondant** (même date, même total EUR). Le module vérifie en cross-check que les numéros de réservation du PDF se retrouvent dans le batch CSV.

### Champs DB écrits (même que Airbnb)

| Champ | Valeur |
|---|---|
| `mad_reel` | `net_EUR × taux_reel` (par réservation) |
| `taux_reel` | Taux extrait du PDF (ex: `10.821384`) |
| `mad_reel_source` | `'booking_pdf'` |
| `mad_reel_updated_at` | ISO datetime |

**Règle immuable** : ces champs ne sont jamais écrits si `mad_reel` est déjà renseigné pour la réservation.

### États d'un batch

| État | Signification |
|---|---|
| `eur_only` | CSV importé, PDF manquant |
| `pdf_ready` | PDF chargé et parsé, en attente validation |
| `applied` | MAD appliqué en base — batch figé |

### Guards dans `applyBkBatch()`

1. PDF refs ≠ batch refs → warning "mauvais PDF ?"
2. Delta taux PDF vs taux calculé (MAD÷EUR) > 0.05 → confirmation obligatoire
3. `mad_reel != null` sur un CRM record → skip silencieux (pas d'écrasement)

### Variables globales Booking

```javascript
var BK_ROWS    = [];   // CSV rows bruts
var BK_BATCHES = [];   // batches groupés par batchId CSV
var BK_ANOM    = [];   // anomalies EUR (écart > 0.50 EUR)
var BK_MISS    = [];   // lignes CSV sans correspondance CRM
var BK_TAB     = 'anom';
var BK_IGN_KEY = 'nex_bk_ignored_v1';  // localStorage
```

### IDs DOM Booking

| ID | Rôle |
|---|---|
| `bk-root` | Conteneur racine section Booking |
| `bk-csv-inp` | Input file CSV |
| `bk-tab-bar` | Barre onglets (masquée jusqu'à import) |
| `bkt-anom` / `bkt-batches` / `bkt-miss` | Boutons onglets |
| `bk-anom-sec` / `bk-batches-sec` / `bk-miss-sec` | Sections contenu |
| `bk-anom-list` / `bk-batches-list` / `bk-miss-list` | Conteneurs rendu |
| `bk-empty` | État vide avant import |

### PDF.js — chargement lazy

PDF.js v3.11.174 est chargé depuis CDN **uniquement lors du premier upload PDF** (pas d'impact sur le chargement initial de la page). Le worker est configuré depuis le même CDN.

### Règles métier immuables Booking (validées 2026-05-18)

| Règle | Valeur |
|---|---|
| Commission par défaut Booking | **22%** — estimation avant réconciliation |
| Taux EUR→MAD fallback | **10.50** — fallback avant MAD réel PDF |
| Vérité EUR | **CSV Booking** (`Informations de versement`) — remplace l'estimation 22% via bouton 📐 Aligner |
| Vérité MAD | **PDF Booking** (`Relevé du paiement`) — taux exact 6 décimales, MAD réel par réservation |
| Impact Dashboard | `rNetMAD` / `rBrutMAD` / `rComMAD` / `sumNetMAD` — Booking traité comme Airbnb via `MAD_REEL_ELIGIBLE` |
| Airbnb | **Jamais touché** par le module Booking — variables, fonctions et DB séparés |

### Flux de réconciliation complet

```
Import CSV → anomalies EUR (écart >0.50) + manquantes détectées
     ↓
📐 Aligner sur CSV → patch brut/commission/net réels + override_manual=true
     ↓
Upload PDF par batch → taux exact + MAD total → applyBkBatch()
     ↓
mad_reel = net_EUR × taux_reel stocké en base
     ↓
Dashboard / KPIs / Réservations → rNetMAD() retourne mad_reel (prioritaire sur EUR×10.5)
```

### Propagation des valeurs corrigées dans le CRM

| Correction | Champs mis à jour | Impacte |
|---|---|---|
| CSV aligné (📐) | `brut`, `commission`, `com_pct`, `net`, `override_manual=true` | Tous calculs EUR + fallback MAD amélioré |
| PDF appliqué | `mad_reel`, `taux_reel`, `mad_reel_source='booking_pdf'` | `rNetMAD` retourne valeur exacte |
| Les deux | Tous les champs ci-dessus | Valeur MAD exacte basée sur EUR corrigé |

Les helpers `rNetMAD/rBrutMAD/rComMAD` sont **source-agnostiques** : ils s'appliquent à Airbnb ET Booking dès que `mad_reel`/`taux_reel` sont renseignés et `type_norm ∈ MAD_REEL_ELIGIBLE`.

### Affichage MAD dans la liste Réservations

- Colonne MAD : `r.mad_reel` si renseigné, sinon `e2m(r.net)` (EUR × EUR_MAD)
- Indicateur `●` bleu : tooltip **"MAD réel Booking · taux X"** ou **"MAD réel Airbnb · taux X"** selon `r.source`

### Ce que le module ne fait PAS

- Ne touche pas aux fonctions Airbnb (aucune variable partagée sauf `DB.resa`, `SUPA`, `ROLE`, `escHtml`, `showToast`)
- Ne crée pas de nouvelle table Supabase
- N'écrase jamais un `mad_reel` déjà renseigné
- Ne gère pas les remboursements / annulations partielles Booking → rester en anomalie manuelle

---

## 16. Module Messages IA — Architecture complète (stabilisé 2026-05-31)

### Objectif

Recevoir les messages voyageurs Smoobu en temps réel, générer un brouillon de réponse via Claude API (Anthropic), le soumettre à validation Hakim avant tout envoi. **Jamais d'envoi automatique.**

### Architecture backend — `api/smoobu-messages.js`

| Endpoint | Méthode | Rôle |
|---|---|---|
| `POST` (no query) | Webhook Smoobu `newMessage` | Récupère messages Smoobu, génère analyse IA complète, INSERT dans `messages` |
| `POST ?regenerate=1` | Regenerate | Regénère brouillon avec instruction Hakim → UPDATE ai_draft/ai_draft_fr/hakim_instruction |
| `POST ?send=1` | Send | Envoie réponse validée via Smoobu API → UPDATE statut='sent' |
| `POST ?sync=1` | Sync threads | Scan des conversations Smoobu récentes → INSERT manquants en DB |
| `GET ?probe=1` | Health check | Retourne `{ ok: true, version: '2.0' }` |
| `GET ?debugBooking=ID` | Debug | État complet conversation Smoobu + DB pour un booking — lecture seule |

### Règle absolue
> **Pas d'envoi automatique — jamais envoyer sans validation de Hakim.**  
> Le bouton Envoyer dans le CRM déclenche un POST `?send=1` uniquement après que Hakim ait relu et validé le brouillon.

### Variables d'environnement requises
```
ANTHROPIC_API_KEY  → Claude API (claude-3-haiku / sonnet) — côté serveur uniquement, jamais frontend
SMOOBU_API_KEY     → Smoobu API (lecture messages + envoi)
SUPABASE_SERVICE_ROLE_KEY → bypass RLS pour INSERT/PATCH messages
```

### Webhook Smoobu — configuration
- URL : `https://nex-estate-seven.vercel.app/api/smoobu-messages`
- **NE PAS remplacer** le webhook `smoobu-webhook.js` existant — Smoobu accepte plusieurs URLs webhook

### Analyse IA — `generateFullAnalysis(ctx)`

Un seul appel Claude API par message, retourne JSON structuré :
```json
{
  "detected_language": "fr",
  "client_summary_fr": "Le voyageur demande l'heure d'arrivée.",
  "classification": "simple",
  "ai_draft": "Bonjour ! Vous pouvez arriver à partir de 15h.",
  "ai_draft_fr": "Bonjour ! Vous pouvez arriver à partir de 15h."
}
```
Classifications possibles :
- `simple` — question/demande standard, brouillon proposé
- `complex` — situation nécessitant une décision (remboursement, problème grave)
- `no_reply_needed` — merci, ok, emoji, confirmation sans question → ai_draft = null

### Détection stale (brouillon obsolète)
- Si un nouveau message guest arrive après la génération du brouillon → `is_stale = true`
- Un brouillon stale est **bloqué** à l'envoi → doit être regénéré
- Expiration automatique après 48h sans activité

### Cron sync threads
- Configuré dans `vercel.json` : quotidien à 8h
- Scan les conversations Smoobu récentes → insère les threads manquants dans `messages`
- Sans doublon (guard sur `smoobu_message_id`)

### UI CRM (section `vw-messages`)

| Élément | Rôle |
|---|---|
| `mn-messages` | Entrée menu nav (admin only) |
| `vw-messages` | Vue principale module |
| Badge rouge | Nombre de threads `statut=pending` |
| Badge "Prospect" | Thread sans réservation CRM associée |
| Filtre statut | pending / sent / treated / all |
| Bouton 🔄 Actualiser | Déclenche `syncMessagesNow()` → POST ?sync=1 |
| Modal thread | Conversation + brouillon IA + traduction FR + instruction Hakim + bouton Envoyer |
| 🎤 Dictée vocale | Web Speech API — saisie vocale de l'instruction Hakim |
| Bouton ✓ Traité | `markTreated(id)` → statut=treated sans envoi |

### Mobile
- Section Messages IA accessible via le drawer "Plus" → `mn-messages` (admin only)
- Pas de modification spécifique mobile — responsive CSS standard

---

## 17. Réconciliation — Lignes manquantes serv + resa_ref (stabilisé 2026-05-31)

### Problème résolu

Certains virements Airbnb (CSV paiements) apparaissaient en rouge "Lignes manquantes" alors qu'ils correspondaient à des services additionnels déjà saisis dans la table `serv` (climatisation, linge, parking, voyageur supplémentaire...). Ces montants sont en EUR dans le CSV mais stockés en MAD dans `serv` → conversion EUR×taux nécessaire avant comparaison.

### Solution — `findServMatch(csv)`

Fonction de matching CSV Airbnb ↔ entrées `DB.serv`.

**Priority 0 — resa_ref exact (100% fiable) :**
- Si `serv.resa_ref` est renseigné → compare avec `csv.code`
- Variantes acceptées : `CODE`, `AIR-CODE`, `CODE` ↔ `AIR-CODE`
- Si resa_ref est renseigné mais ne match pas → skip ce serv (pas de fuzzy fallback)

**Fuzzy (si resa_ref absent) — 3 critères successifs :**
1. **Montant MAD ±5%** (min 5 MAD) : `csv.net × taux` vs `serv.montant`
2. **Date ±15 jours** : `csv.checkin` vs `serv.date` (Check D utilise `crmBase.checkin`, pas `res.date`)
3. **Voyageur accent-normalisé** (bloquant uniquement si les deux sont renseignés) : `_normStr()` mappe é/è/ê→e, ñ→n, ç→c, à/â→a etc., compare par mot ≥ 3 chars

**`_normStr(s)` :**
```javascript
function _normStr(s) {
  return String(s || '').toLowerCase()
    .replace(/[àâä]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o')
    .replace(/[ùûü]/g, 'u').replace(/[ýÿ]/g, 'y')
    .replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c');
}
```

### Checks concernés

| Check | Condition | Action si match serv |
|---|---|---|
| **Check A** | Réservation absente du CRM | → checkId='A_SERV', level='ok' (vert) |
| **Check D** | Versement résolution / AirCover absent | → checkId='A_SERV', level='ok' (vert) — Check D utilise `crmBase.checkin` pour la date |

### Rendu `renderMissingSection()`

| Groupe | Couleur | Comptage badge |
|---|---|---|
| `resAbsent` (checkId='A') | Rouge | ✅ Compté |
| `acAbsent` (checkId='D') | Rouge | ✅ Compté |
| `servMatched` (checkId='A_SERV') | **Vert** | ❌ Exclu du badge |

La section verte "Déjà dans services additionnels · N virement(s)" est affichée après les sections rouges. Chaque carte montre : code + badge ✓ Dans serv + montant EUR + voyageur · logement + cause détaillée (svc · montant MAD · date · voy).

### Champ `resa_ref` dans le formulaire Services additionnels

- Input texte + datalist autocomplete (`buildServResaOptions()`) — 80 dernières réservations Airbnb (ref, voyageur, checkin)
- Optionnel : si laissé vide, le fuzzy seul s'applique
- Si renseigné : match Priority 0 → lien 100% fiable, aucune ambiguïté
- Migration Supabase appliquée : `ALTER TABLE serv ADD COLUMN IF NOT EXISTS resa_ref TEXT`

### Contraintes immuables
- Ne pas refondre le module Réconciliation existant
- Ne pas toucher au reste du module (Airbnb MAD réel, Booking)
- Toute modification de `findServMatch` doit préserver les 3 critères et la priorité resa_ref
