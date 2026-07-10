# Nex-Estate CRM — Contexte projet Claude Code

> Fichier de mémoire projet pour Claude Code.  
> À lire automatiquement au démarrage de chaque conversation dans ce dossier.  
> Ne pas modifier les fichiers de code sans instruction explicite.

---

## 1. Vue d'ensemble

**Nex-Estate CRM** est un outil de gestion de réservations locatives courte durée (Airbnb, Booking.com, VRBO, Direct) pour 4 appartements au Maroc.

- **Frontend** : `index.html` unique (~14 474 lignes), vanilla JS, zéro framework, zéro build
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
| `pay_source` | text NULL | Plateforme d'encaissement : `null`=Terrain/Direct, `'Airbnb'`, `'Booking'`, `'Autre'` — ajouté 2026-06-06, nullable, migration `ALTER TABLE serv ADD COLUMN IF NOT EXISTS pay_source text` |

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
- Calcul : `nuits_sejour × (adultes + enfants) × tauxTaxe(appart)` — la taxe est due par personne, enfants compris (corrigé 2026-06-29, commit `cbbdda8`)
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

**B. Cron polling quotidien** (`/api/smoobu-poll.js`)
- Cron `0 12 * * *` (une fois par jour, 12h UTC) défini dans `vercel.json` — **plan Vercel Hobby = crons quotidiens uniquement**, le déclenchement réel a lieu dans l'heure qui suit (ex: 12h47). Le webhook temps réel reste le canal principal ; le poll est un filet de sécurité quotidien.
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
| `buildForm('resa', id)` | Génère le modal d'édition. Calcul `brutMad` : priorité `mad_reel` → `brut × taux_reel` → fallback `brut × EUR_MAD`. Badge contextuel affiché sous le champ. |
| `saveResa()` | Sauvegarde une réservation depuis le modal. Préserve `mad_reel/taux_reel/mad_reel_source/mad_reel_updated_at` depuis `DB.resa` — jamais écrasés par Enregistrer. |
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
| 2026-05-31 | **STABLE** : réconciliation serv + resa_ref opérationnelle — commit `1caabe8` |
| 2026-06-02 | Feat(reconcil): _suggestedMAD étendu — cas 2 : écart EUR seul (sans régularisation), pré-remplit le MAD depuis payoutMAD × (netCSV / originalEUR) (`364c2e0`) |
| 2026-06-02 | Feat(reconcil): check B-MADAPPLIED — quand `mad_reel != null && !override_manual && absEcart >= 0.01`, affiche "MAD réel enregistré — EUR non aligné → corriger via ✏️ Modifier" (`36a694c`) |
| 2026-06-02 | Fix(reconcil): B-MADAPPLIED étendu aux lignes `override_manual=true` qui ont aussi un mad_reel (cas Eva Jakob — mad_reel appliqué + EUR corrigé via alignement, arrondi résiduel détecté correctement) (`1550368`) |
| 2026-06-02 | Fix(reconcil): infos techniques masquées par défaut dans Anomalies CSV — lignes purement informatives (type non financier, doublon technique…) n'encombrent pas la file principale (`c7a1f6b`) |
| 2026-06-02 | Fix(reconcil): classification Anomalies CSV — niveaux affinés : arrondi ≤0.10€ → info, 0.10–1€ → minor, ≥1€ → anomaly/crit selon contexte (`042c3f1`) |
| 2026-06-03 | **STABLE** : Réconciliation Airbnb — B-MADAPPLIED + classification infos techniques — commit `1550368` |
| 2026-06-03 | fix(reconcil): Check D — matching AirCover/Résolution prioritaire par subtype CSV. Remplace `DB.resa.find()` non prioritaire par sélection en 2 passes (`_dPrefCands` / `_dFallCands`). Cas HMPJ5EQJZA corrigé : AirCover 86 EUR → `-AIRC` (AIRCOVER), pas `-Resol` (AJUSTEMENT). Anomalie "matching ambigu" si plusieurs candidats du même type (`342fe81`) |
| 2026-06-04 | fix(reconcil): Check D — EUR non aligné (écart de taux < 5%) → niveau `minor` + bouton ⚡ Aligner EUR. `alignDAnomaly(i)` : patch brut/net/commission/com_pct + override_manual=true. Fix libellé causeD : distingue "AirCover" vs "Résolution" via `res.isAircover` (`5a782ab`) |
| 2026-06-04 | fix(reconcil): Check D — MAD prioritaire pour AIRCOVER/AJUSTEMENT quand `_payoutMAD` connu. `_payoutMAD` vérifié AVANT le guard EUR < 1€ (qui pouvait masquer des écarts MAD importants via EUR coïncidant accidentellement). Ex : HMBKW3WYPQ — 1 645 vs 1 693 MAD, EUR coïncidant à 0.04€. Nouveau bloc D-MAD-PRIORITAIRE + `fixDMadAnomaly(i)` + bouton ⚡ Corriger MAD (`7b89457`) |
| 2026-06-04 | fix(reconcil): `fixDMadAnomaly` — retrait écriture `mad_reel`/`taux_reel` pour AIRCOVER/AJUSTEMENT. `_payoutMAD` peut représenter le lot entier (contamination batch), rendant la valeur MAD non fiable. Seul l'EUR CSV est aligné. Guard EUR < 0.01€ ajouté dans D-MAD-PRIORITAIRE pour éviter fausses anomalies après alignement (`5b7c8f6`) |
| 2026-06-04 | fix(reconcil+display): badge "MAD réel Airbnb" protégé par `MAD_REEL_ELIGIBLE` dans renderResa (mobile + tableau). Avant : `r.mad_reel != null` → affichait badge pour TOUS les types. Après : guard identique à `rNetMAD()`. `fixDMadAnomaly` définitivement nettoyé : patch EUR uniquement (`dfca571`) |
| 2026-06-04 | DB fix : HMPJ5EQJZA-AIRC — `mad_reel/taux_reel/mad_reel_source/mad_reel_updated_at → NULL` (valeurs erronées écrites par `fixDMadAnomaly` avec `_payoutMAD` de lot contaminé = 1 423.94 au lieu de 920.22). Note alignement EUR conservée. |
| 2026-06-04 | fix(modifier-resa): `buildForm` utilise désormais `mad_reel` → `brut × taux_reel` → fallback `brut × EUR_MAD` pour pré-remplir le champ MAD. Badge contextuel "MAD réel Airbnb · taux X.XXXX" ou "MAD fallback · taux 10.50" affiché sous le champ. `saveResa()` préserve `mad_reel/taux_reel/mad_reel_source/mad_reel_updated_at` depuis `DB.resa` — aucun écrasement possible via Enregistrer. |
| 2026-06-04 | feat(reconcil): `mad_reel/taux_reel` écrits pour AIRCOVER/AJUSTEMENT. `MAD_REEL_ELIGIBLE` étendu. `isPayoutMadFiable()` : lot mono → bouton auto, lot mixte → saisie manuelle. `fixDMadAnomaly` (fiable) + `fixDMadManual` (lot mixte). Guard anti re-flag : `mad_reel_source='complexe'` → return silencieux aux imports suivants. (`06d432c`) |
| 2026-06-04 | fix(reconcil): guard EUR seul ne bloque plus saisie MAD quand `mad_reel=NULL` (HMPJ5EQJZA-AIRC : EUR=86€=86€ mais MAD jamais saisi car guard tirait return avant comparaison MAD). Fix : `|EUR| < 0.01 && mad_reel != null` (`1af5b2d`) |
| 2026-06-04 | fix(reconcil): pre-pass CSV — `payoutByCodeResol` accumulait plusieurs payouts sur la même référence. Remplacé par `_resolBatchList[code]=[{batchId,madAmt}]` + consommation séquentielle `_resolBatchIdx`. HMPJ5EQJZA : 920.22 (23/05) + 503.72 (20/05) = 1 423.94 faux → chaque résolution reçoit maintenant son propre MAD. (`65541b9`) |
| 2026-06-04 | **STABLE** : Réconciliation MAD réel AIRCOVER/AJUSTEMENT — pré-pass, Check D, KPI — commit `65541b9` |
| 2026-06-05 | fix(modifier-resa): correction complète en 4 commits (`1f221d4`→`905f6f3`). `buildForm` : `brutMad = brut×taux_reel` (jamais `mad_reel`), `netMad = mad_reel` si disponible. `saveResa` : préserve `brut/net/commission` EUR et `mad_reel/taux_reel` quand `taux_reel` existe — aucune dérive possible. DB fix HMNMXRCNYQ (Ikram Badri) : `brut/net/commission` restaurés depuis `mad_reel/taux_reel` après altération par test. |
| 2026-06-05 | **STABLE** : Modifier réservation — affichage MAD réel + Enregistrer idempotent — commit `905f6f3` |
| 2026-06-06 | feat(depenses-business): filtre statut `b-fst` — option "À payer" ajoutée pour les charges fixes importées (`7ce7530`) |
| 2026-06-06 | fix(charges-fixes): `saveBiz` préserve `recurring_charge_id` et `recurring_month` lors d'un PATCH statut manuel — corrige la création de doublons à la regénération (`6ae6391`) |
| 2026-06-06 | feat(serv): champ `pay_source` nullable — plateforme d'encaissement dans le formulaire Services additionnels ; `col`/`pay` automatiquement nullifiés pour Airbnb/Booking ; migration Supabase appliquée (`fd9ef52`) |
| 2026-06-06 | fix(serv): "Collecté par" masqué quand `pay_source ≠ null` — `#ff-serv-col` toggle via `onchange` sur `fi-pay-source` (`ba4b06d`) |
| 2026-06-06 | fix(serv): "Mode de paiement" masqué pour Airbnb/Booking — `#ff-serv-pay` toggle ; badge `chip(r.pay\|\|(r.pay_source\|\|'Cash'))` dans renderServ/renderTaxe (`d33e30d`) |
| 2026-06-06 | fix(dashboard): CA Airbnb réel — `_caResaAirbnb` déplacé après `revRes` pour cohérence signe ; carte Airbnb "Répartition par source" enrichie : "Réel Airbnb : X MAD / dont Y MAD extras" (`5025043`) |
| 2026-06-06 | fix(dashboard): dec-card "Meilleure source" enrichie — "Réel : X MAD" en orange si Airbnb+extras (`9ff251a`) |
| 2026-06-06 | feat(serv+dash): modal "🏷 Plateformes" (admin) — liste les services `pay_source=null && resa_ref`, croise DB.resa, pré-coche Airbnb, PATCH sur sélection uniquement (`398e53e`) |
| 2026-06-06 | **STABLE** : Module CA Airbnb réel validé — Airbnb mai 2026 : 67 621 MAD resa + 776 MAD extras = 68 397 MAD réel ← commit `398e53e` |
| 2026-06-06 | feat(perso): CATS_P 16→22 catégories — 6 nouvelles, migration 13 "Autre perso", filtre catégorie dynamique depuis CATS_P |
| 2026-06-06 | feat(perso): charges récurrentes perso — table recurring_charges type=perso, génération mensuelle/trimestrielle/annuelle dans perso |
| 2026-06-06 | feat(perso): bloc "Charges fixes" rétractable entre résumé catégories et filtres, mini KPIs, tabs Trim/Année, anti-doublon génération, totaux lissés |
| 2026-06-06 | fix(perso): exclure réellement les doublons manuels à la génération — section "Ignorées" dans la prévisualisation |
| 2026-06-06 | feat(perso): contrôle doublons — bouton 🔍, détection affinée (récurrent+catFixe+libellé similaire), suppression manuelle avec cases |
| 2026-06-06 | feat(perso): budget lissé — calcLissePerso() partagée, rangée KPI contextuelle vue Mois (charges fixes réelles / budget lissé / écart) |
| 2026-06-06 | **STABLE** : Module Dépenses Perso complet — `1c249fd` |
| 2026-06-08 | feat(resa): filtres multi-select Appartement/Source/Type/Statut (Commits H→K) ; feat(serv): multi-services + champ `note` (Commit L, migration `add_note_to_serv`) |
| 2026-06-08 | Audit complet 73/100 → `ROADMAP.md` créé (P1/P2/P3 + bugs connus + décisions actées) |
| 2026-06-09 | feat(logements): stats par appartement — CA, occupation (dates séjour réelles), résultat net ; feat(taux): auto-lock EUR_MAD (`autoLockTaux()` au chargement + au save) + badge taux dans liste + champ taux manuel modale ; multi-source fallback chain EUR/MAD + cache localStorage |
| 2026-06-09 | feat(dashboard): barchart CA mensuel 12 mois ; export CSV 4 vues avec sélecteur de période ; vue "À suivre" (badge nav + mini-résumé + 3 blocs + actions groupées) ; recherche texte Taxe/Services/Perso + recherche globale Business ; auto-sync taxes Booking au chargement |
| 2026-06-09 | feat(dashboard): **CA unifié** = réservations + services payés + taxe de séjour — KPI principal, sparkline, perf cards par appartement, meilleur appart (`681dd40`) |
| 2026-06-10 | feat(dashboard): CA unifié par source — carte "Répartition par source" : Airbnb = resa + extras `pay_source='Airbnb'` (anti-doublon AIRCOVER/AJUSTEMENT conservé), Booking.com = resa + extras `pay_source='Booking'` + taxe de séjour, ligne dédiée "Terrain / Direct" pour les extras hors plateforme (`c5d7137`) |
| 2026-06-10 | feat(serv): autocomplete "Réservation liée" — Airbnb+Booking, recherche voyageur/code/appart accents ignorés (`servSugNorm`), fallback nom Voyageur, sync auto appartement+voyageur au choix (`6487eeb`→`6f674ef`) ; note extras cash par source client via resa_ref dans la carte source (`ed35a0c`) |
| 2026-06-10 | feat(alerte): heartbeat sync Smoobu — table `sync_heartbeat` (RLS read authenticated, écriture service_role only), `writeHeartbeat()` dans smoobu-poll, badge rouge sidebar `smoobu-hb-alert` si > 2h (`654fb39`) |
| 2026-06-10 | fix(taux): er-api.com en premier (taux quotidien frais 00h02 UTC, date via unix timestamp), frankfurter.app retirée (domaine mort, ECB sans MAD), currency-api jsdelivr en secours (`52bef78`) |
| 2026-06-10 | fix(resa): correction manuelle du MAD réel verrouillé — modifier "Montant net (MAD)" sur une resa verrouillée → confirm() explicite → mad_reel mis à jour, net EUR recalculé au taux figé, commission=brut−net, `mad_reel_source='manuel'` (`1764ef7`) |
| 2026-06-10 | **RÈGLE MAJ** : `mad_reel_source='auto'` (auto-lock) = estimation remplaçable par la réconciliation. Guards assouplis : Airbnb `addRow`, Booking `applyBkBatch`, filtre post-apply, B-MADAPPLIED skip 'auto'. Les sources `manuel` / `CSV Airbnb payout` / `booking_pdf` restent intouchables |
| 2026-06-10 | feat(sync): `syncStatutsDB()` au boot — PATCH ciblé des statuts dérivés expirés vers Supabase (AJUSTEMENT et ANNULATION_NON_PAYEE exclus) ; 20 statuts périmés nettoyés en base le jour même (`fe7b619`) |
| 2026-06-10 | Alerte Smoobu testée en réel (antidate 6h → badge visible → restauré) ; audit complet base : 0 anomalie (0 payée sans verrou, 153 CSV Airbnb + 55 booking_pdf + 6 complexes intacts) |
| 2026-06-10 | Backup `nex-estate-crm-backup-2026-06-10-stable-complet` produit (projet + git + skills dans `_skills_backup/`) — suppression ancien backup 2026-06-09 |
| 2026-06-10 | **P3.8 Mobile complet** (dernier item roadmap — roadmap close) : filtres grille 2 colonnes <700px toutes vues (`b2ba95a`) ; cartes Réservations avec checkout (`30be250`) ; modals bottom-sheet pleine largeur + inputs 16px anti-zoom iOS (`2130201`) ; Dashboard mobile — cartes récap en colonne, delta dédié, barchart 9px, filtre appart pleine largeur (`1456910`) |
| 2026-06-10 | fix(mobile): Récap équipe en 1 colonne — retour terrain Hakim, 2 colonnes illisibles (`dabe09e`) |
| 2026-06-10 | **UX globale lot 1** : feedback fiable — saveOne/deleteOne/upsert retournent ok/échec, `toastSaveResult()` vert/rouge 6s sur les 5 save* + delEntry, confirm suppression enrichi, toast au-dessus mobnav (`a680b92`) ; FAB mobile "+ Ajouter" contextuel via `updateFab()` dans goTo (`4bb5e6f`) ; mémoire derniers choix appart/collecteur Taxe+Serv (`lastChoice`/`setLastChoice`, localStorage `nex_last_*`, Business exclu volontairement) (`760dd77`) |
| 2026-06-10 | **UX globale lot 2** : bouton ⭐ extra lié depuis une résa — `addExtraForResa(id)` ouvre modal Services pré-rempli resa_ref/appart/voyageur, `actBtns(type,id,extraHtml)` étendu (`dbf3f91`) ; retour en haut mobile `#scrolltop-btn` visible après 600px de scroll (`c29f7d9`) |
| 2026-06-10 | **UX globale lot 3 (parité desktop)** : retour en haut étendu au desktop — bas droite 24px, hover orange (`1d95810`) ; raccourcis clavier desktop — `N` nouvelle entrée vue active, `/` recherche (`KBD_SEARCH`), `Échap` ferme modal/aide, `?` aide (`showKbdHelp`, auto-expire 10s) ; guards saisie/modal/rôle (`9c5c68c`) |
| 2026-06-11 | **fix(alerte sync)** : le cron poll est QUOTIDIEN (12h UTC, plan Hobby) pas horaire — l'alerte seuil 2h était rouge en permanence à tort. Webhook écrit désormais un heartbeat (`id='smoobu-webhook'`, detail=action) ; `checkSmoobuHeartbeat()` lit toutes les lignes, prend la plus récente, seuil 26h (`077178c`) |
| 2026-06-11 | **fix(taxe)** : KPIs — "Par Hakim" (`col==='Hakim'` ne matchait jamais les noms team `HAKIM HARRAASSE`) remplacé par : Collecté terrain (pay≠Booking) / Via plateforme (pay=Booking) / Non reversé / Reversé ; colonnes "Collecté par"+"Paiement" fusionnées en "Collecte" (chip "Via Booking" ou personne+mode) (`e10157a`) |
| 2026-06-11 | **fix(serv)** : Résumé par service — les combos multi-services ont leur propre carte (bord doré, "n× · combo") au lieu d'attribuer le montant complet à chaque service (341=108+233 corrigé) ; somme des cartes = Total période (`dd574df`) |
| 2026-06-11 | **feat(serv)** : formulaire — sélecteur de services compact (`fi-svc-btn` + dropdown `fi-svc-drop` avec recherche `svcDropFilter`, chips, fermeture clic-dehors/bouton Valider) remplaçant les 11 checkboxes figées ; **montant par service en création multi** (`fi-svc-amts`, total auto readonly `svcAmountsTotal`) → `saveServ()` crée UNE LIGNE `serv` PAR SERVICE avec son montant (helpers `svcSelected/svcSelChanged/svcAmountsRefresh`). Le sélecteur `#fi-svc-wrap .fi-svc-cb` est conservé (compat `addExtraForResa`) (`00502f5`) |
| 2026-06-12 | **feat(serv)** : montant par service aussi en ÉDITION — un ancien combo édité affiche les champs par service (hint "X MAD à répartir" via `wrap.dataset.orig`) et est **divisé** à l'enregistrement : ligne existante = 1er service (id conservé), suivants créés avec `uid()`. `saveServ()` branche multi sans condition `!M_ID` (`c2cca28`) |
| 2026-06-12 | **UX Lisibilité** (chantier UX item 1 clos) : états vides actionnables — hint filtres + bouton Ajouter, helper `emptyStateHtml`, 5 vues desktop+mobile (`da53cfe`) ; hiérarchie KPIs — `.kc-hero` sur le KPI principal de chaque vue, 23px/20px + accent latéral couleur module (`6712e91`) ; harmonisation Services — colonne "Collecte" fusionnée comme Taxe, chip "Via Airbnb/Booking", supprime le faux "Cash" des extras plateforme (`1a7c428`) |
| 2026-06-12 | **feat(ux)** : Récap équipe mobile en carrousel — 1 membre à la fois, flèches tactiles centrées + compteur X/N (`renderWkCards` : mobile toujours perPage=1, desktop inchangé ≤5 grille / >5 pagination 4). Demande terrain Hakim (`844ee58`) |
| 2026-06-12 | **feat(dashboard) blocs Smoobu** : "📅 Mois à venir" M+1..M+3 (CA confirmé, nuits, % occupation sécurisée — `renderFutureMonths`, `joursDispoAppart`) + barchart 12+3 mois futurs translucides (`8b35274`) ; parts par source — mini-anneau SVG % CA, % nuits, annulations période (`_miniRing`, **`filterResa` pas `filterPer`**) (`cb2d8de`) |
| 2026-06-12 | **fix(sync) CRITIQUE — récidive detectSrc** : `api/smoobu-poll.js` avait sa propre copie de `detectSrc` avec l'ancien ordre (booking avant direct) — le fix 06-09 n'avait corrigé que `lib/smoobu-normalizer.js` (webhook). Le webhook classait Direct ✓ puis chaque poll ré-écrasait → Booking.com + commission 22% + taxe fantôme + auto-lock mad_reel faux. Fixes (`11afce6`) : ordre aligné, fallback `b.type` retiré ("modification of booking" piège), `isInfoManquante` exempte Direct (ref=smoobu_id à vie). DB : Sami ALHerz corrigé (source/com/net/taxe/mad_reel), taxe fantôme 256.66 supprimée, 0 autre résa touchée. Diagnostic : `?probe=ID` + `sync_heartbeat` (poll vs webhook) |
| 2026-06-13 | **feat(ux) multi-sélection uniformisée** : barre sélection Réservations déplacée tout-en-haut → **juste au-dessus du tableau** (`r-sel-bar` avant `r-pgbar`, cohérent avec Business/Taxe/Services — fini de remonter pour agir) (`5365300`) ; **Dépenses Perso** multi-select complet (`PERSO_SEL`, checkboxes lignes+master+cartes, barre Marquer Payé/En attente/Supprimer, `bulkPerso`/`deletePersoSel` admin-only, modèle Business) (`15abda2`) ; **Charges récurrentes** multi-select (`RECUR_SEL`, checkboxes+master, barre Activer/Désactiver en masse `bulkRecurActive` via `update.in`) (`3fed36c`). Pattern sel-bar désormais identique sur 6 blocs : resa/business/taxe/serv/perso/recur (`d807943`) |
| 2026-06-13 | **feat(ux) audit UX #2 — pastille de statut cliquable** : bascule du statut en 1 clic sans modal, dans la table ET les cartes mobiles, sur les 4 blocs de paiement — Business/Serv/Perso (`statut` Payé⇄En attente), Taxe (`rev` Reversé⇄Non reversé). Réservations **exclues volontairement** (statut dérivé de `date_paiement`, réécrit au boot par `syncStatutsDB()` → un toggle manuel y serait perdu). 3 helpers réutilisables : `statusPill(k,r)` (rendu chip identique + interactivité si droit d'écriture), `canTogglePill(k)` (perso=admin, business/serv/taxe=`canDo('write_*')`), `togglePillStatut(ev,k,id)` (flip mémoire → `saveOne` → `toastSaveResult` → re-render, **rollback mémoire si l'écriture base échoue**). CSS `.ch-clk` : curseur pointer, ring au survol (`currentColor` inset), focus visible, caret `⇄` en `::after`. Vérifié en preview (rendu + toggle + garde-fous rôle), déployé Vercel READY prod (`0c2f296`) |
| 2026-06-13 | **fix(business) unification statut** : le statut **`À payer`** (posé uniquement par la génération des charges récurrentes, ligne ~2451) était orphelin — absent du modal Modifier (qui ne propose que Payé/En attente) et compté dans **aucun KPI** (ni Payé ni En attente) → charges fixes générées dans un angle mort. **Fusionné dans `En attente`** : 2 statuts cohérents partout (comme Services/Perso). Génération → `'En attente'` ; `MS_STS` (filtre statut Business) = `['Payé','En attente']` ; migration base : 6 lignes `À payer` (2 378 MAD) → `En attente` (désormais comptées dans le KPI En attente, qui passe à 10 874 MAD). Modal + pastille cliquable déjà sur 2 statuts → cohérence totale (`cb1904a`) |
| 2026-06-13 | **feat(business) split payé/en attente sous le Total** : le KPI Total comptabilise TOUTES les dépenses (payées + en attente), ce qui prêtait à confusion (on pouvait croire Total = déjà payé). Ajout d'une ligne `b-split` sous le Total : `✅ X payé · ⏳ Y en attente` (vert/rouge), avec `payé = total − en attente` → toujours cohérent avec le montant Total affiché. Rappel des 2 découpages du Total : par **type** (Ménage + Charges = Total) et par **état** (Payé + En attente = Total) (`8e12dda`) |
| 2026-06-13 | **feat(ux) audit UX #4 — mémoire des filtres par bloc** : les filtres choisis sont mémorisés (localStorage `nex_filters_v1`) et restaurés au lancement suivant, sur les 5 blocs (Réservations, Business, Taxe, Services, Perso). Persiste les **sélections** (multi-selects appart/cat/source/type/statut/équipe/payeur, selects DOM collecteur/service, champs recherche) — **PAS la période** (Mois/Année/Cumulé reste sur le mois courant au boot, volontaire). `saveBlockFilters(block)` appelé dans les 5 fonctions `*Filter()` (point d'accroche unique) ; `restoreAllFilters()` appelé au boot après `populateTeamSelects()` (t-fcol/s-fcol dynamiques → `.value` posé après) et avant le 1er rendu ; restaure état JS + valeurs DOM + labels boutons (`ms*RenderBtn`) + surbrillance `ms-on`. Vérifié preview (save→reset→restore complet) (`cbf96b4`) |
| 2026-06-13 | **refactor(ux) contrôle de période unifié** : avant = incohérence (Réservations/Dashboard en menu déroulant, Business/Taxe/Services/Perso en onglets, jeux de périodes différents) + rangée de presets Réservations (Aujourd'hui/7j/30j/Mois en cours) faisant **doublon** avec le déroulant et **bloquant les flèches de mois** (bug `R_QUICK` concurrent de `filterResa`). Après = **UN SEUL menu déroulant identique sur les 6 blocs** (resa/dash/biz/taxe/serv/perso) : `Jour · Semaine · Mois · Trimestre · Semestre · Année · Période libre · Tout l'historique`. Bimestre retiré. Suppression rangée presets + `setResaPreset` + système `R_QUICK` ; `setPer()` simplifié (tous via select `{k}-per`) ; ajout cas `cumul` dans `filterResa` (manquant) ; Business/Taxe/Services gagnent Trim/Semestre/Année, Perso gagne Semestre/Période/Cumulé. Vérifié preview (filtrage mois/cumul/année/trimestre correct, 6 blocs, 0 erreur) (`309ee46`) |
| 2026-06-13 | **feat(ux) barre de filtres collante (desktop)** : demande Hakim — filtrer sans remonter en haut dans une longue liste. Classe `.fb-sticky` (`position:sticky;top:8px`) ajoutée aux 6 barres de filtres (resa/dash/biz/taxe/serv/perso ; barre config Réconciliation exclue). **Piège stacking** : `position:sticky` crée TOUJOURS un contexte d'empilement → cassait les déroulants multi-sélection (overlay `ms-ov` z-209 passait au-dessus de `ms-drop` z-210). Fix : `.fb-sticky` en `z-index:210` (au-dessus de `ms-ov`) + barre de sélection remontée `z-30→z-220` (reste prioritaire quand les 2 barres se croisent). **Mobile** : barre ≈40% de l'écran (trop haute) → `position:static` dans la media query <700px ; desktop garde le sticky. Vérifié preview (fige à top:8 après scroll, déroulants cliquables au-dessus de l'overlay, mobile static) (`3359556`) |
| 2026-06-13 | **feat(ux) barre de filtres collante AUSSI sur mobile (compacte + bouton Filtres)** : le sticky desktop était désactivé sur mobile (barre complète ≈40% écran). Solution façon applis mobiles pro : barre collante **compacte repliée par défaut** — restent visibles période + mois (la date) + bouton `🔧 Filtres` ; un tap déplie appartement/catégorie/statut/équipe/payeur/recherche (≈18% écran replié vs 40%). `.fb-toggle` injecté par `initFbToggles()` dans chaque `.fb-sticky` (masqué desktop) ; `.fb-collapsed` (défaut) cache `.ms-wrap`+`input.fsel`+`select.fsel:not([id$=-per])` en <700px (inerte desktop) ; `toggleFb()` + `refreshFbToggles()` (libellé + compteur `(n)` de filtres actifs + surbrillance `fb-on`, visible même replié) appelé dans les 5 `*Filter()` + boot ; sticky réactivé mobile. Vérifié preview (mobile replié 18% sticky, tap déplie 353px, compteur+surbrillance, scroll top:8 ; desktop inchangé) (`25f107d`) |
| 2026-06-14 | **feat(ux) audit UX #3 — palette de commandes Ctrl+K** : `Ctrl+K`/`Cmd+K` (desktop) ou bouton `🔎 Recherche` du tiroir Plus (mobile) ouvre une palette façon Linear/Notion. 4 groupes : **Réservations** (recherche voyageur/réf/appart/source accents ignorés → navigue vers resa + filtre la liste sur la réf), **Aller à** (15 sections, filtrées par rôle via `cmdkCanAccess`=même liste que `goTo`), **Actions** (nouvelle entrée resa/biz/taxe/serv/perso, filtrées rôle), **Rechercher dans** (remplit la recherche de Business/Services/Perso/Taxe). Navigation clavier ↑↓/Entrée/Échap + survol/clic. Module autonome injecté à la 1re ouverture (overlay z-950) ; binding `Ctrl+K` dans le handler global AVANT le guard input (marche même en saisie) ; Échap ferme la palette en priorité ; aide `?` mise à jour. Fonctions : `openCmdK/closeCmdK/cmdkBuild/cmdkRender/cmdkExec/cmdkMove/cmdkNorm`. Vérifié preview (Ctrl+K ouvre/Échap ferme, recherche resa avec contexte, nav role-filtrée, exec navigue+ferme+filtre) (`76c7ce1`) |
| 2026-06-14 | **fix(messages-ia) 2 retours terrain Hakim** : ① **fausses alertes Prospect/voyageur inconnu/« erreur de traitement webhook »** — Smoobu déclenche un webhook `newMessage` pour les inquiries/prospects (gros `booking_id` ~690M) mais `GET /reservations/{id}/messages` renvoie **404 Entity not found** (l'API n'expose pas les conversations sans réservation) → le `catch` créait un record `error` visible. Fixes : `getSmoobuMessages` 404→`{messages:[]}` (skip propre, pas d'exception) ; webhook `catch` ne crée plus de record `error` visible (log serveur + 500 pour retry) ; **14 faux records `error` supprimés en base** (12 étaient ce 404). ② **l'IA ne lisait que le DERNIER message** — le webhook ne passait que `lastMsg` à Claude → réponse hors-contexte quand le client écrit en plusieurs messages successifs. Fix : transcript des **5 derniers messages voyageur** passé à `generateFullAnalysis` (champ `conversation`) + stocké en `message_content` (le fil complet s'affiche) ; prompt « réponds à L'ENSEMBLE ». Rétrocompatible (1 message = inchangé ; sync paths inchangés) (`1ea66b8`) |
| 2026-06-14 | **fix(messages-ia) 2 points** : ① **faux échecs d'envoi** — Smoobu renvoie souvent `201 "Resource created successfully"` **sans `id`** dans le corps ; `sendSmoobuMessage` exigeait un `id` pour `confirmed` → des envois RÉUSSIS étaient marqués `error`. Fix : 2xx (passé le guard `!res.ok`) = envoyé, `confirmed=true` sans exiger d'id. ② **sync alignée sur le webhook** — helper partagé `buildGuestTranscript()` (5 derniers msgs voyageur) utilisé dans le webhook + les 3 appels du sync threads + le sync Booking.com → l'IA répond à l'ensemble des messages successifs sur TOUS les chemins (temps réel ET filet quotidien) (`4583e88`) |
| 2026-06-14 | **feat(messages-ia) recherche « Conversation par client »** (façon Smoobu/Airbnb) : backend `GET /api/smoobu-messages?conversation=BOOKING_ID` → messages voyageur (Smoobu, lecture seule) + réponses envoyées via le CRM (`messages` statut=sent) fusionnés/triés par date (404 prospect → `{messages:[]}`). Frontend vue Messages IA : barre de recherche → filtre `DB.resa` (résas Smoobu uniquement, accents ignorés, 1 par `smoobu_id`) → clic ouvre modal fil de discussion (`conv-ov`, voyageur à gauche / « Vous (via CRM) » à droite, bulles + horodatage, Échap ferme). **Limite Smoobu affichée** : l'API n'expose PAS les réponses hôte tapées directement dans l'appli Airbnb/Smoobu ni les prospects → vue = messages voyageur + réponses CRM (de plus en plus complète à mesure que Hakim répond depuis le CRM). Vérifié preview (recherche + rendu bulles) (`4f281d2`) |
| 2026-06-14 | **feat(messages-ia) répondre/envoyer depuis le CRM** : limite Smoobu **confirmée empiriquement** (`debugBooking=143041602` → 7 msgs TOUS `type=1` voyageur ; l'API ne renvoie JAMAIS les réponses hôte, peu importe où elles sont tapées → miroir complet impossible). **Solution** : faire du CRM l'outil d'envoi → les réponses envoyées depuis le CRM sont stockées + affichées dans le fil. Backend : `POST ?sendDirect=1 {booking_id,text,voyageur,appart,source}` → `sendSmoobuMessage` + INSERT record `statut=sent`. Frontend : (a) **conversation** = zone de réponse + `convGenerate` (manualDraft sur le fil voyageur) + `convSend` (confirm→sendDirect→recharge) ; `convOpen` attend `_convLoad`. (b) **IA Manuelle** = champ « Client/réservation » (`manualClientSearch/Pick` sur `DB.resa` Smoobu) → cible le booking + pré-remplit plateforme/logement ; bouton « Envoyer à <client> » après génération. **Sécurité : tout envoi = clic explicite + confirm(), jamais auto.** Vérifié preview (`9801454`) |
| 2026-06-14 | **feat(messages-ia) bouton « Reformuler »** : retour Hakim — l'IA doit AMÉLIORER son propre texte (orthographe + ton pro, garder son idée), pas seulement générer à sa place. Backend : `rewordReply()` + `POST ?reword=1 {text,source,appart}` → Claude reformule le brouillon de l'hôte (règles strictes : même sens/intention, **AUCUNE info inventée**, même langue, ton pro sans emojis, renvoie juste le texte). Frontend : bouton `✏️ Reformuler` dans la zone de réponse conversation (entre Générer et Envoyer) → `convReword()` envoie le texte tapé, remplace par la version polie ; tooltips distinguant Générer (rédige depuis le client) vs Reformuler (polit VOTRE texte). Vérifié réel prod (« salut le code wifi ces... bone journer » → « Bonjour, Le code Wi-Fi est NEXESTATE2026... Bonne journée. », code/heure conservés) (`f386aee`) |
| 2026-06-14 | **feat(messages-ia) micro partout + Reformuler dans IA Manuelle** : ① helper générique `voiceMic(targetId,btnId)` (Web Speech API fr-FR, ajoute au texte existant, abort la dictée des cartes `MSG_VOICE_REC` pour éviter conflits) sur : réponse conversation (`conv-mic-btn`), message IA Manuelle (`manual-msg-mic`), instruction (`manual-instr-mic`), brouillon éditable (`manual-draft-mic`). ② IA Manuelle : brouillon généré devient **éditable** (`manual-draft-edit` textarea) + boutons `✏️ Reformuler` (`manualReword`) / `📋 Copier` (`manualCopyDraft`) / `📤 Envoyer à <client>` (`manualSendDraft`) opérant sur le texte modifié. Vérifié preview (`1cced29`) |
| 2026-06-14 | **feat(messages-ia) assistant IA itératif (3 briques)** — vision Hakim « parler à l'IA comme à un humain ». ① **Affiner** (`?assist=1` mode=refine) : champ consigne + micro + bouton 🔄 Affiner → l'IA révise le brouillon selon la consigne + le message client (itératif). ② **Conseil** (`?assist=1` mode=advise) : bouton 🧐 Conseil → l'IA relit le brouillon + contexte et donne des notes FR (à vérifier, info risquée type code/horaire, ton) **sans réécrire**. ③ **Apprentissage du style** : `getHakimStyleExamples()` récupère ses dernières réponses ENVOYÉES (`statut=sent`) et les injecte en few-shot (`styleBlock`) dans reword + refine + génération (`generateFullAnalysis`/manualDraft) → imite son ton, de plus en plus à mesure qu'il répond via le CRM. Frontend : rangée Assistant (instruction+micro+Affiner+Conseil+zone conseil) dans conversation ET IA Manuelle. Sécurité inchangée (aucun envoi auto). Vérifié réel prod (refine polit sans inventer ; advise a flaggé « code wifi en clair = risque » + « 13h à confirmer ») (`8fd9345`) |
| 2026-06-14 | **feat(messages-ia) BASE DE CONNAISSANCES par appartement (#5 — « recruter l'IA »)** — l'IA répond précisément avec les vraies infos de chaque logement. **DB** : colonne `logements.kb` (jsonb). **Frontend** : bouton `🤖 Fiche IA` par logement (vue Logements, admin) → éditeur (wifi nom/code, check-in/out, adresse+étage, accès, parking, équipements, **services & tarifs**, règles, FAQ) + indicateur « Fiche IA ✓ » sur la carte ; `openLogementKB`/`saveLogementKB`. **Backend** : `getApartmentKB(nom)` lit `logements.kb` ; `kbBlock()` injecte « INFORMATIONS VÉRIFIÉES DE CE LOGEMENT » dans le prompt + **RÈGLE ABSOLUE code serrure** (jamais donné par l'IA → « envoyé le jour de l'arrivée après vérification des pièces d'identité » ; wifi communicable). Injecté dans `generateFullAnalysis` (webhook + 3 sync threads + Booking.com + manualDraft) et `assistReply` (refine). **4 fiches pré-remplies** depuis les guides voyageur Smoobu — **extraits via l'API guest** : `GET https://login.smoobu.com/api-guest/bookings/{id}/contents?token={t}` renvoie les sections du guide (la page `guest.smoobu.com` est une SPA React, contenu via cette API). Vérifié réel prod : voyageur Touahri 11 demande wifi+code porte → IA donne le wifi, refuse le code serrure (règle exacte), répond parking avec tarif (`4e93515`) |
| 2026-06-14 | **feat(messages-ia) IA consciente de la PHASE DU SÉJOUR + composition** : retour Hakim — l'IA répondait comme si le client n'était pas encore arrivé alors qu'il était déjà sur place. Helper `stayPhase(checkin,checkout)` → `avant`/`veille`/`arrivee`/`encours` (déjà sur place)/`depart`/`termine`. Injecté « PHASE DU SÉJOUR » + composition (adultes/enfants) dans `generateFullAnalysis` + `assistReply`, avec règles : **si déjà sur place, ne jamais proposer d'envoyer code/wifi/accès** (il les a déjà) ; avant l'arrivée, code serrure envoyé le jour J après vérif ID. `kbBlock` code-serrure rendu phase-neutre. `getResaContext` récupère `adults,children`. Dates+compo passées par webhook + 3 sync threads + Booking.com + manualDraft + assist ; frontend conversation & IA Manuelle (client sélectionné) transmettent checkin/checkout/adults/children. + **Fiche Touahri 11 : règles PISCINE** (été 15/06-10/09, baignade réservée aux <14 ans, adultes interdits) dans FAQ. Vérifié réel prod : (1) séjour en cours → « vous avez reçu le code lors de votre arrivée » (passé) ; (2) piscine 2 adultes → « adultes ne peuvent pas se baigner » ; 2 adultes+2 enfants → « vos 2 enfants peuvent en profiter » (`e7b5667`) |
| 2026-06-14 | **feat(messages-ia) messagerie style Airbnb — traduction auto** : Hakim travaille 100% en français. Backend `POST ?translate=1` : `{texts:[...]}` → traduit le lot en français + détecte la langue source (`translateBatchToFrench`) ; `{text,to}` → traduit le texte de Hakim vers la langue du client (`translateToLang`). Frontend conversation : messages affichés en **français par défaut** (traduits au chargement via `_convRenderMsgs`), bouton `🌐 Voir l'original/français` (`convToggleLang`), indicateur « Client : <langue> — réponse traduite à l'envoi » (`_convUpdateLangBar`). `convGenerate` produit le brouillon en FR (`ai_draft_fr`). `convSend` traduit le FR de Hakim → langue client avant envoi (confirm montre la version traduite). Vérifié réel prod (EN+ZH→FR avec détection ; FR→EN). **WhatsApp** : possible via WhatsApp Business API (fournisseur Twilio/360dialog, coût+validation Meta) = projet à part ; en attendant IA Manuelle (copier-coller) couvre le besoin (`b24fc2b`) |
| 2026-06-29 | **fix(taxe) CRITIQUE — la taxe de séjour ne comptait pas les enfants** : retour terrain Hakim — le calcul auto utilisait `nuits_sejour × adultes × tauxTaxe`, sous-comptant les enfants alors que la taxe est due par personne (adultes + enfants) → taxes (et prix annoncés au client) trop bas. Corrigé dans les **2 chemins source** de `taxe_sejour` : `lib/smoobu-normalizer.js` (webhook + poll, réservations live) et `index.html` parseSmoobu (import CSV, repli si city tax Smoobu absente) → `nuits_sejour × (adultes + enfants) × tauxTaxe`. Le formulaire (`nb_personnes`) était déjà correct. **3 réservations existantes corrigées en base** (Booking + enfants + ancienne formule) : 5843811712 Grace 24→36€, 5152949175 Lahcen 8→16€, 5304397341 Vincenzo 12→24€ ; les taxes corrigées manuellement / réelles Smoobu préservées (WHERE = match exact ancienne formule). Déployé Vercel READY prod (`cbbdda8`) |
| 2026-07-02 | **fix(messages-ia) CRITIQUE — les réponses de l'hôte remontent enfin (`onlyRelatedToGuest=false`)** : retour terrain Hakim — ses réponses (tapées dans Airbnb/Booking/Smoobu) n'apparaissaient pas dans le CRM → historique incomplet + IA sans contexte. Le support Smoobu a indiqué le paramètre `onlyRelatedToGuest=false`. Vérifié empiriquement (booking 140560917 : `GET /reservations/{id}/messages` = 11 msgs tous type=1 ; `?onlyRelatedToGuest=false` = 25 msgs dont 15 type=2 hôte). Fix : paramètre ajouté dans `getSmoobuMessages()` (un seul point de lecture → propagé au webhook, sync, scan Booking, endpoint `?conversation=`, re-fetch envoi). Anti-doublon ajouté dans `?conversation=` : les réponses envoyées via le CRM remontant aussi côté Smoobu, on dé-duplique par texte normalisé (garde le CRM uniquement pour les envois pas encore synchro / repli si Smoobu down). **Effet de bord POSITIF** : `hostRepliedAfter` (webhook L2180 + sync L1279), jusque-là structurellement morte, redevient fonctionnelle → auto-résolution des pending déjà traités sur la plateforme. Corrige l'audit erroné du 2026-06-12 (section 16). Déployé Vercel READY prod |
| 2026-07-02 | **feat(smoobu-auth) — migration signature HMAC-SHA256 (deadline Smoobu 25/09/2026)** : Smoobu impose la signature HMAC de toutes les requêtes API à partir du 25/09/2026 (les requêtes non signées → 401). Ajout d'un helper `smoobuFetch()` **auto-contenu et identique** dans `api/smoobu-messages.js` ET `api/smoobu-poll.js` (pattern maison = duplication, aucun `import` local ESM ailleurs → zéro risque build). Les **7 points d'appel** Smoobu passent par ce helper (getSmoobuMessages, sendSmoobuMessage, threads ; poll: enrich ×2, probe, liste réservations). **Signature activée UNIQUEMENT si `SMOOBU_API_SECRET` est présent** ; sinon mode legacy (clé seule, non signé) = comportement actuel → déploiement sûr. Format vérifié contre l'API réelle (4 GET signés → 200) : `canonical = METHOD\nPATH\nQUERY(trié alpha + URL-encodé, variante ENCODÉE)\nTIMESTAMP(ISO8601 sans ms)\nNONCE(uuidv4)\nSHA256hex(body ; vide=SHA256(""))\nAPIKEY` ; `X-Signature = base64(HMAC-SHA256(canonical, SECRET))` ; HMAC key = secret **brut** (pas base64-décodé). En-têtes signés : `X-API-Key, X-Timestamp, X-Nonce, X-Signature`. ⚠️ **Nouvelle clé** `usr_live_…` = signature OBLIGATOIRE (non signé → 401) ; **ancienne clé** `dl8uRDO2…` = marche non signée jusqu'au 25/09. **ACTIVATION** = mettre à jour DEUX vars Vercel ensemble : `SMOOBU_API_KEY`=nouvelle clé `usr_live_…` **+** `SMOOBU_API_SECRET`=secret, puis redéployer. Scripts de validation : `test-smoobu-hmac.mjs` (local). **ACTIVÉ en prod le 2026-07-03** (déploiement `98009e5`) : `SMOOBU_API_KEY`=`usr_live_…` + `SMOOBU_API_SECRET` définis en Production Vercel (`--no-sensitive`, valeurs vérifiées exactes ; ⚠️ le pipe stdin de `vercel env add` stocke du vide → toujours utiliser `--value=`). Lectures signées confirmées **200** en prod (debugBooking messages + poll probe) ; comme `usr_live_…` exige la signature, un 200 prouve la signature correcte. ⚠️ Preview NON configuré (bug CLI `git_branch_required`, sans impact : aucun déploiement Preview créé dans ce workflow). Restes : (1) confirmer le POST `send-message-to-guest` via un vrai envoi ; (2) supprimer l'ancienne clé legacy `dl8uRDO2…` après quelques jours de stabilité (encore active jusqu'au 25/09). **POST confirmé le 2026-07-03** (envoi « merci » à Thami Jebbari HMKK2J49PY reçu sur Airbnb) → migration HMAC 100% validée. |
| 2026-07-03 | **fix(messages) CRITIQUE — historique tronqué : l'endpoint messages Smoobu est PAGINÉ (25/page)** : retour terrain Hakim — même avec `onlyRelatedToGuest=false`, le CRM n'affichait qu'un DÉBUT de conversation (vieux messages), pas les récents. Cause : `GET /reservations/{id}/messages` renvoie `{page_count,page_size:25,total_items,page,messages}` — **page_size FIXE à 25** (`pageSize`/`limit` ignorés), **page 1 = les 25 plus ANCIENS**. `getSmoobuMessages()` ne lisait que la page 1 → conversations > 25 msgs tronquées (messages récents = pages ≥2, jamais récupérés). Vérifié : Nancy Rachedi `145626671` = **61 msgs sur 3 pages** (page 1 seule = début uniquement) ; `140560917` = 35 (pas 25). Fix : `getSmoobuMessages()` boucle sur `?page=N` de 1 à `page_count` (garde-fou MAX_PAGES=20 = 500 msgs) et concatène. Se propage aux 6 usages (webhook, sync ×3, endpoint `?conversation=`, re-fetch envoi). **Effet correctif majeur au-delà de l'affichage** : le webhook/sync trouvaient « le dernier message voyageur » DANS les 25 plus anciens → pour les longues convos, ils analysaient un vieux message et `hostRepliedAfter` était faussé ; désormais ils voient le vrai dernier message. Déployé Vercel READY prod |
| 2026-07-03 | **perf(conversation) + auto-refresh + re-paramétrage IA** : suite retour Hakim (ouverture d'un fil = 25-60s, « traduction en cours »). (1) **Perf** : `_convLoad()` affiche le fil IMMÉDIATEMENT en texte original puis traduit en TÂCHE DE FOND (avant : on attendait la traduction de tous les messages, ~23s pour 56, avant d'afficher). Ne traduit QUE les messages voyageur (réponses hôte déjà FR). Cache global `window._TRANS_CACHE` (réouverture/refresh instantanés). `translateBatchToFrench` max_tokens 2048→4096. Backend `getSmoobuMessages` : pages 2..N en PARALLÈLE (Promise.all) → fetch 5,3s→~2s. (2) **Auto-refresh** : indicateur « 🔄 Synchronisé il y a X min » (id `conv-sync`) + bouton rafraîchir (`conv-refresh-btn`) + auto-refresh 60s (re-render seulement si nouveau message via signature `_sig` → pas de saut de défilement) ; garde-fous `_loading` (anti-chevauchement) et `_CONV_CUR` (anti-cross-conversation) ; timers créés 1× dans `_convModal`. (3) **Re-paramétrage IA** (`generateFullAnalysis` msgBlock, L255+) : l'ancien prompt supposait les réponses hôte INVISIBLES → devinait le « déjà traité » par l'ancienneté. Réécrit en logique FACTUELLE : répondre seulement aux messages voyageur NON suivis d'une réponse « Hôte » ; si le dernier élément du fil = « Hôte » → `no_reply_needed` ; APPRENDRE des réponses « Hôte » de Hakim (source de vérité, ne pas contredire/répéter, imiter son ton). Contexte IA porté à 12 derniers messages (convFull, avant 8). Validé prod : cas répondu→no_reply_needed, cas non-répondu→brouillon pertinent. (4) **Prospects** : investigation — `/threads` liste 406 conversations mais TOUTES liées à un `booking.id` (type reservation/modification) ; les prospects purs (inquiry sans réservation) ne sont pas exposés par l'API → message support Smoobu à envoyer. Thami Jebbari = booking `145609621` (27 msgs, « c'est fait » visible). Déployé Vercel READY prod |
| 2026-07-03 | **feat(messages) — liste unifiée de TOUTES les conversations Smoobu** : avant, la messagerie ne listait que les fils présents dans NOTRE base (`?recentConversations=1`, table `messages` = seulement les convos déjà traitées par webhook/pending). Ajout d'une visibilité COMPLÈTE via l'API Smoobu `/threads` (406 conversations connues de Smoobu, triées par activité récente). Backend : `GET ?allThreads=1&page=N` → `/threads?page_number=N&page_size=25` (signé), nettoie (nom, logement, dernier message text_content, date UTC), renvoie `{page,page_count,total,conversations}`. Frontend (`vw-messages`) : section « 🗂️ Toutes les conversations » (id `conv-all`) sous les récentes, même style, bouton « Charger plus » (pagination, accumule `window._ALL_THREADS`), masquée pendant la recherche ; `renderAllThreads(1)` au chargement de la vue ; ouverture via `convOpenAllThread`→`convOpenBooking`. ⚠️ Les threads sont TOUS liés à un booking (pas de prospects purs — cf. entrée précédente, en attente support Smoobu). Validé prod (page 1 & 2, 25/page, total 406). Déployé Vercel READY prod |
| 2026-07-03 | **fix(messages) — « Conversations récentes » = source Smoobu /threads (FUSION des 2 listes) + fix timezone Berlin** : retour terrain Hakim — la liste récentes montrait un dernier message PÉRIMÉ et un ordre FAUX (Nancy affichée au 02/07 alors que sa vraie dernière activité = 03/07 09:01) car elle lisait NOTRE base (seuls les messages traités par le CRM y figurent). Fix : `renderRecentConvos()` utilise `?allThreads=1` (ordre réel + vrai dernier message, y compris réponses tapées sur les plateformes) + « Charger plus » (bouton `conv-more`, accumule `window._RECENT_CONVOS`) ; le filtre par DATE conserve la source DB (`_renderRecentFromDB`, aussi utilisée en REPLI si /threads échoue) ; section doublon « Toutes les conversations » supprimée (fusionnée). **⚠️ FAIT STRUCTUREL Smoobu — TIMEZONE** : `/threads` renvoie `latest_message.created_at` en heure de **BERLIN** (Europe/Berlin), PAS en UTC — vérifié : même message = 20:27 via `/reservations/{id}/messages` (UTC) vs 22:27 via `/threads` (été UTC+2). Conversion Berlin→UTC via Intl dans le handler `allThreads` (`berlinToIso`), sinon heures affichées +2h. Vérifié prod : Nancy 03/07 09:01 = heure réelle d'envoi. Déployé Vercel READY prod |
| 2026-07-04 | **feat(ia) — audit 360° du bloc Messages IA + optimisation qualité (P1+P2+P3)** (`5bdbe66`). Audit complet code+DB : les 4 fiches IA (`logements.kb`) sont complètes ; base saine (0 pending, 0 erreur). **3 failles corrigées** : (P1) les chemins AUTOMATIQUES (webhook + sync ×3 + scan Booking) et **Régénérer** ne passaient PAS les réponses hôte à l'IA — le webhook/sync envoyait `buildGuestTranscript` (5 msgs voyageur seuls) et Régénérer n'envoyait AUCUNE conversation, alors que le prompt du 03/07 demande à l'IA d'exploiter les réponses « Hôte ». Nouveau helper `buildFullTranscript(allMessages, limit=12)` (voyageur + hôte, dates relatives) branché sur webhook (`whFullConv`), sync threads (`_conv`), scan Booking (`_convBc`), et Régénérer (`freshConversation`, re-fetch Smoobu). (P2) brouillons `generateFullAnalysis` + assist *refine* → **`claude-sonnet-5`** (const `MODEL_DRAFT`, max_tokens 2048) ; traduction/reword/vision/advise restent Haiku (const `MODEL_LIGHT`=`claude-haiku-4-5-20251001`). (P3) `getHakimStyleExamples` : lit ×4 puis filtre ≥80 car. AVANT le limit + déduplication + 8 exemples (avant : filtre après limit → parfois 4 exemples dont « Je vous en prie 🙏 ») ; `style_examples` désormais injectés dans les 3 chemins sync (jamais passés avant). Mini-fix : seuil `isTrivialMessage` 30→15 car. Vérifié prod (manualDraft Touahri 11 : allusion « la voiture » reliée au parking, prénom, wifi déjà traité non répété, infos parking mot-pour-mot depuis la fiche). Déployé Vercel READY prod |
| 2026-07-04 | **fix(ia-manuelle) — fil complet transmis à l'IA quand un client Smoobu est sélectionné** (`23cd02d`). L'IA Manuelle passe par `?manualDraft=1`→`generateFullAnalysis` donc bénéficie auto de Sonnet+style+fiche+phase. **Manque corrigé** : avec un client sélectionné, la conversation n'était PAS transmise (génération sur le seul message collé). `msgManualDraftGenerate()` récupère désormais le fil (voyageur + hôte, 12 msgs) via `?conversation=<booking_id>` avant de générer (best-effort). Prospects (pas de résa → pas de fil Smoobu, confirmé support) : inchangé, contexte = ce que Hakim colle. Déployé Vercel READY prod |
| 2026-07-04 | **fix(ia) CRITIQUE — extraction robuste des réponses Sonnet (bloc thinking avant le texte)** (`064995a`). Cas réel Kumba (Touahri 11, 10:15 UTC) : contre-proposition départ tardif « 14h / 20€ » → record `pending` SANS brouillon (ai_draft NULL, résumé NULL, aucune erreur) alors qu'un brouillon « je vérifie et je reviens vers vous » était attendu. **Cause** : `claude-sonnet-5` réfléchit PAR DÉFAUT sur les cas délicats (adaptive thinking activé quand `thinking` est omis, contrairement à Haiku) → la réponse contient un bloc `thinking` AVANT le bloc `text` ; le code lisait `content[0].text` → undefined → parse JSON échouait → fallback all-null silencieux. Les cas simples (sans réflexion) marchaient, d'où le test parking OK le matin. **Fix** : helper `claudeTextOf(data)` (concatène TOUS les blocs `text`) branché sur les 5 points de lecture (generateFullAnalysis, analyzeImageMessage, rewordReply, assistReply, _claudeText) ; max_tokens 2048→4096 (draft) et 1024→2048 (refine) car la réflexion compte dans la limite. **Vérifié prod en rejouant le cas réel** : brouillon parfait (« je vérifie la disponibilité pour un départ jusqu'à 14h et je vous reviens avec une demande de paiement ajustée ») — comprend la contre-proposition vs les 13h déjà acceptées, ne confirme rien. Record Kumba passé `resolved` (Hakim avait répondu sur Airbnb) ; seul message touché ce jour. ⚠️ RÈGLE : toute lecture de réponse Claude passe par `claudeTextOf()`, jamais `content[0].text`. Déployé Vercel READY prod |
| 2026-07-06 | **fix(taxe) RÉCIDIVE — le poll comptait la taxe sur les adultes seulement** (`6f0d1f6`). Retour terrain Hakim : résa Hafsa El Jattari (Touahri 11, 2 adultes + 2 enfants, 1 nuit) → taxe 4€ au lieu de 8€, ALORS QUE le fix `cbbdda8` (2026-06-29) était censé régler ça. **Cause** : `cbbdda8` avait corrigé `lib/smoobu-normalizer.js` (webhook) et `index.html` (CSV) mais PAS `api/smoobu-poll.js` qui a SA PROPRE COPIE du calcul (L271-273 : `city-tax` Smoobu prioritaire puis `nuits × adultes × taux`) — **même pattern que la récidive detectSrc du 2026-06-12**. Mécanisme : le webhook écrivait la taxe correcte à la création, puis le cron quotidien de midi (cas C = UPDATE complet) la ré-écrasait avec l'ancienne formule → « ça revient tout seul ». Preuve : Grace Kabengele (5843811712), corrigée 24→36€ le 29/06, retrouvée à 24€ le 06/07. **Fix** : bloc taxe du poll aligné MOT POUR MOT sur le normalizer — `nuits × (adultes + enfants) × tauxTaxe(ap)`, Booking uniquement, `city-tax` Smoobu ignoré (parité webhook↔poll, sinon ping-pong quotidien). **DB réparée** : Hafsa 4→8€ (+ ligne `taxe` auto 42.83→85.66 MAD, Non reversé), Grace 24→36€ (ses lignes `taxe` CASH terrain non touchées — l'argent réellement collecté est un fait) ; Fayçal Sibarni (5612670039, avril, `override_manual=true`, taxe Reversée 84 MAD) laissé en l'état → décision Hakim. ⚠️⚠️ **RÈGLE ANTI-RÉCIDIVE (2 incidents identiques)** : la logique métier réservations existe en **3 COPIES** — `lib/smoobu-normalizer.js` (webhook), `api/smoobu-poll.js` (mapSmoobuBooking, cron midi) et `index.html` (parseSmoobuRow/CSV). **Toute correction de règle métier doit être grep-ée et appliquée dans LES TROIS**, sinon le cron de midi ré-écrase silencieusement chaque jour (`override_manual=false`). **VÉRIFIÉ E2E le 2026-07-06** : Hakim a déclenché « ⚡ Sync API » (même code que le cron) → Hafsa toujours 8€ / Grace toujours 36€ après re-traitement ; contrôle global = 0 résa Booking restante à l'ancienne formule (hors verrouillées). **Décision Hakim** : ne PAS corriger les anciennes taxes (Fayçal 5612670039 reste en l'état — historique reversé) ; seul le présent/futur compte. Déployé Vercel READY prod ← **HEAD** |
| 2026-07-09 | **feat(ia) — CONTRÔLE DE COHÉRENCE message ↔ réservation** : retour terrain Hakim (cas Jawad) — un client écrit « moi, ma femme, mes enfants » alors que sa réservation est pour 1 personne, et l'IA ne le remarquait pas. L'IA recevait déjà adultes/enfants (compoLine) sur tous les chemins mais le prompt ne demandait jamais de COMPARER. Ajouts dans `api/smoobu-messages.js` : (1) bloc « ⚡⚡ CONTRÔLE DE COHÉRENCE » dans le systemPrompt de `generateFullAnalysis` — comparer ce que dit le voyageur (nombre de personnes, dates, logement) aux données officielles de la réservation ; si écart sur les personnes → classification `sensible` + `client_summary_fr` préfixé « ⚠️ INCOHÉRENCE : » (chiffré) + brouillon qui répond normalement PUIS demande poliment de confirmer/mettre à jour le nombre de voyageurs sur la plateforme (règle PERSONNES DÉCLARÉES, ton jamais accusateur) ; anti-faux-positifs explicites (nombre ≤ composition = cohérent, compo absente = ne rien signaler, bébé seul ne déclenche pas) ; (2) compoLine renommée « Composition RÉSERVÉE (donnée officielle de la plateforme) » ; (3) mode `advise` (🧐 Conseil) vérifie aussi la cohérence composition. Un seul fichier touché (prompts messagerie = 1 seule copie, pas concerné par la règle des 3 copies). |
| 2026-07-09 | **feat(ia) — envoi TOUJOURS en FRANÇAIS, fin de la traduction sortante (économie tokens)** : décision Hakim — il envoie tous ses messages en français, Airbnb/Booking traduisent automatiquement pour le client (vérifié : lui-même lit les messages chinois en français dans l'appli Airbnb). La traduction sortante était donc une double dépense inutile. **Backend** (`generateFullAnalysis` + `analyzeImageMessage`) : `ai_draft` rédigé EN FRANÇAIS toujours (règle ⚡⚡ Langue), `ai_draft_fr` demandé vide au modèle (économie ~50% des tokens de sortie du brouillon) et rempli côté code en MIROIR de `ai_draft` (l'UI lit `ai_draft_fr` → zéro cassure ; si un ancien format renvoie une traduction, elle reste prioritaire) ; salutations et `hakimStyleGuide` passés en français (Salam conservé si le client salue en darija). **Frontend** : `convSend` et `msgSend` n'appellent PLUS `?translate=1 {text,to}` (envoi du texte FR tel quel), sélecteur « Langue d'envoi » des cartes remplacé par une note informative, bandeau conversation « vous répondez en français, la plateforme traduit ». **CE QUI RESTE TRADUIT (voulu)** : les messages ENTRANTS du voyageur → français pour Hakim (`?translate=1 {texts}` batch + cache, inchangé). `detected_language` conservé (info langue client). L'endpoint `translateToLang` reste en place mais plus aucun appelant sortant. Bonus : les exemples de style (`getHakimStyleExamples`) deviennent 100% français. |
| 2026-07-10 | **fix(ia) — retry automatique sur saturation Anthropic + erreurs lisibles + consigne = message proactif garanti** : retour terrain Hakim (cas Jawad Zine, 14:45 UTC) — 2 clics « Régénérer » avec consigne → aucun brouillon, aucune explication. Logs Vercel : 2 × **« Claude API: 529 Overloaded »** (saturation ponctuelle côté Anthropic, pas un bug CRM ; la consigne était bien transmise). 3 fixes dans `api/smoobu-messages.js` : (1) **helper `claudeCall(payload,label)`** — TOUS les appels Claude (brouillon, image, reword, assist, translate — plus aucun fetch direct) retentent jusqu'à 2 fois (1 s puis 2,5 s) sur 429/500/502/503/529 ; un 529 revient en <1 s donc compatible maxDuration 30 s ; jamais de retry sur 400/401/crédit ; (2) **`friendlyIaError()`** appliqué aux 10 catch → « L'IA d'Anthropic est momentanément surchargée — attendez quelques secondes et recliquez » / « Crédit API épuisé — rechargez sur platform.claude.com » au lieu du code brut ; (3) **⚡⚡ EXCEPTION ABSOLUE à la règle de récence** dans msgBlock : une INSTRUCTION DE HAKIM désactive « dernier élément = Hôte → no_reply_needed » (cas Jawad = message proactif : le client n'avait rien écrit depuis la réponse hôte). Frontend `convGenerate` : l'erreur backend s'affiche DANS la case réponse (placeholder), pas seulement en toast fugace ; la consigne reste remplie → recliquer suffit. |
| 2026-07-10 | **feat(ia) — SALUTATION CONTEXTUELLE (retour Hakim : « Bonjour <Prénom> » à chaque bulle = robot)** : l'ancienne RÈGLE ABSOLUE N°1 forçait le prénom dans CHAQUE message, même à 2 minutes d'intervalle. Nouvelle règle (3 endroits alignés : RÈGLE N°1 de `generateFullAnalysis`, `hakimStyleGuide`, `styleBlock`) : saluer avec le prénom UNIQUEMENT en début de conversation OU après une pause > ~6 h / un autre jour (reprise) ; en pleine conversation (échanges rapprochés) → enchaîner directement SANS re-saluer, comme une messagerie instantanée ; QUAND on salue, toujours avec le prénom (jamais « Bonjour » seul — inchangé). **Prérequis technique** : les horodatages du fil passaient de jour en jour seulement → **HH:MM ajouté** dans `buildFullTranscript` + `buildGuestTranscript` (backend, UTC) et `_convBuildContext` (frontend, heure locale navigateur) pour que l'IA mesure l'écart réel entre messages. `salutLine` reformulée (« quand elle est appropriée »). |
| | **📌 RESTE (prochaine session) : P4** — mesurer le KPI « 80% » : brouillon IA original vs texte réellement envoyé → % de brouillons envoyés sans retouche ; option : compteur coût IA du mois dans le CRM. **Stratégie Hakim** : valider TOUS les messages manuellement d'abord ; envoi auto (cas « simple » uniquement) seulement quand le KPI prouve la qualité sur plusieurs semaines ; jamais d'auto sur sensible/conflit/remboursement. **Billing** : crédit prépayé Anthropic (pas d'abonnement) ; ~3,39 € au 2026-07-04, pas d'auto-reload → surveiller (à zéro l'IA s'arrête en silence, le CRM continue). Console : platform.claude.com → Billing / Usage. |

---

## 12b. Dashboard — blocs inspirés Smoobu (2026-06-12)

- **Bloc "📅 Mois à venir"** (`#d-future-months`, `renderFutureMonths()`) : cartes M+1..M+3 — CA confirmé (`mois_kpi` futur via `sumNetMAD`), nuits réservées (`occupNightsBiz`), % occupation sécurisée (`computeJoursDispo` global ou `joursDispoAppart(ap,...)` si filtre appartement). Lecture seule.
- **Barchart étendu** : boucle `i=11..-3` — 12 mois passés + 3 futurs (`isFuture`, barres translucides "confirmé à venir").
- **Parts par source** (carte Répartition par source) : `_miniRing(pct,color)` anneau SVG % du CA ; % des nuits (`nuits_sejour`, types RESERVATION/RELOCATION/DIRECT) ; annulations de la période (`filterResa` + type_norm ANNULATION*). ⚠️ Pour filtrer les résas par période : **`filterResa()`** (date_paiement/mois_kpi), jamais `filterPer()` (qui lit `r.date`, inexistant sur resa).

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
- **Architecture CSS mobile (2026-06-10, P3.8)** — tout dans le bloc `@media(max-width:700px)` :
  - Filtres : `.fb .fr` passe en `display:grid;grid-template-columns:1fr 1fr` ; `.tabs`, `div[id$="-nav"]`, `select[id$="-per"]` et `input.fsel` (recherches) prennent `grid-column:1/-1` ; les multi-selects `.ms-wrap` s'appairent en 2×2 ; `#vw-dash .fb .fr>select` pleine largeur
  - Modals : `.ov` aligné en bas, `.mbox` bottom-sheet pleine largeur (`max-height:94dvh`, coins arrondis haut) ; `.fi/.fse` à 16px (anti-zoom iOS)
  - Cartes récap `.rc` (Revenus par appartement, Répartition par source) : `flex-direction:column`
  - Barchart 12 mois : labels `_bfs = isMobile() ? 9 : 8` px dans `renderMonthlyBarchart()`
  - Cartes Réservations : row3 = `📅 checkin → checkout` (checkout en MM-DD si même année)

---

## 14. Module Réconciliation Airbnb — Règles métier (stabilisé 2026-06-03)

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

### Régularisations Airbnb — MAD réel net (ajouté 2026-06-02)

`batchRate = payoutMAD / csvNet` est gonflé quand `csvNet` inclut déjà une déduction → `madReel = crm.net × batchRate` faux. `_payoutMAD` est la valeur correcte.

`_suggestedMAD` résout ce problème en deux cas :

| Cas | Détection | Valeur |
|---|---|---|
| Régul même payout | `_hasNegativeRegul` ou `_hasRegulResol` | `csvRow._payoutMAD` |
| Régul autre payout | `buildCrossNegMap()` via `airbnbBaseRef` | `_payoutMAD - Σ(adj × taux_payout_adj)` |

`buildCrossNegMap(MAD_REEL_ROWS)` appelée après `buildMadRealRows()`. N'affecte pas les lignes sans régularisation (`_suggestedMAD = null` → comportement inchangé).

Coexistence avec `_hasNetMismatch` : les deux corrections s'affichent ensemble (complémentaires, pas en conflit).

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

### Check B-MADAPPLIED — MAD traité, EUR non aligné (ajouté 2026-06-02)

Déclencheur : `crm.mad_reel != null` ET `absEcart >= 0.01 EUR` (que `override_manual` soit true ou false).

| Écart | Niveau | Message |
|---|---|---|
| ≤ 0.10 EUR | `info` | ✅ MAD réel enregistré — arrondi EUR · aucune action requise |
| 0.10 – 1 EUR | `minor` | MAD réel enregistré — EUR non aligné → corriger via ✏️ Modifier si nécessaire |
| ≥ 1 EUR | `anomaly` | ⚠️ MAD réel enregistré — EUR non aligné → corriger via ✏️ Modifier |

**Cas Eva Jakob** (commit `1550368`) : `mad_reel` appliqué + EUR corrigé via alignement CSV → `override_manual=true`. Le check B-MADAPPLIED s'applique aussi dans ce cas (écart résiduel d'arrondi). Niveau `info` (≤ 0.10 EUR).

**Note** : quand B-MADAPPLIED renvoie vers ✏️ Modifier, le formulaire `buildForm` affiche désormais le MAD réel (`mad_reel` → `brut × taux_reel` → fallback). Un badge bleu "MAD réel Airbnb · taux X.XXXX" confirme la source. `saveResa()` préserve `mad_reel/taux_reel` — aucun risque de dériver les données validées.

### Check D — AirCover / Résolution : règles complètes (stabilisé 2026-06-04)

#### Matching prioritaire par subtype CSV (commit `342fe81`)

```javascript
// subtype='aircover'   → préférer AIRCOVER en CRM, AJUSTEMENT en fallback
// subtype='resolution' → préférer AJUSTEMENT en CRM, AIRCOVER en fallback
var _dPrefCands = _dAllCands.filter(r => r.type_norm === _dPreferred);
var _dFallCands = _dAllCands.filter(r => r.type_norm === _dFallback);
// Si plusieurs candidats du même type → anomalie "Matching ambigu"
```

#### Flux de décision Check D (ordre strict — ne pas modifier)

```
1. [NOUVEAU] D-MAD-PRIORITAIRE : crmAc + _payoutMAD + (AIRCOVER ou AJUSTEMENT)
   → Guard EUR aligné : |crmAc.net - res.net| < 0.01 → return silencieux
   → crmMAD = crmAc.mad_reel ?? (crmAc.net × taux)
   → |crmMAD - _payoutMAD| ≤ 1 MAD → info "MAD conforme"
   → |crmMAD - _payoutMAD| > 1 MAD → anomaly/minor "MAD versé différent" + bouton ⚡ Corriger MAD
   → return (conclusif — ne passe jamais aux étapes suivantes)

2. Guard EUR classique : |res.net - crmAc.net| < 1€ → return silencieux
   (uniquement quand _payoutMAD absent, ou non AIRCOVER/AJUSTEMENT)

3. D-EUR-MISALIGNED : devise EUR + 1€ ≤ |écart| < 5% du net CSV
   → level='minor', _dEurMisaligned=true → bouton ⚡ Aligner EUR

4. Anomalie finale : |écart| ≥ 5%
   → level='anomaly', cause = "[AirCover/Résolution] — montant différent"
```

#### Boutons d'action Check D (admin uniquement)

| Bouton | Condition | Patch DB |
|---|---|---|
| ⚡ Aligner EUR | `_dEurMisaligned=true` (écart 1€–5%) | `brut=net=csv.net, commission=0, com_pct=0, override_manual=true` |
| ⚡ Aligner EUR + MAD réel | `_dMadEcart` présent + `_madFiable=true` (lot solo) | `brut=net=csv.net, mad_reel=_payoutMAD, taux_reel=MAD/EUR, mad_reel_source='CSV Airbnb payout', override_manual=true` |
| ⚡ Saisir MAD réel | `_dMadEcart` présent + `_madFiable=false` (lot mixte) | input éditable pré-rempli suggestion · patch identique au cas fiable mais `mad_reel_source='CSV Airbnb complexe / validation manuelle'` |

#### Règles AIRCOVER/AJUSTEMENT + mad_reel (MAJ 2026-06-04)

- `MAD_REEL_ELIGIBLE = ['RESERVATION','ANNULATION_PAYEE','RELOCATION','AIRCOVER','AJUSTEMENT']`
- AIRCOVER/AJUSTEMENT **sont désormais éligibles** à `mad_reel` quand il est renseigné
- `rNetMAD()` utilise `mad_reel` pour ces types → impact KPI réel (CA, ADR, RevPAN, marge)
- Sans `mad_reel` (null) → fallback `net × EUR_MAD` inchangé
- `isPayoutMadFiable(res)` : lot mono-transaction + taux ∈ [3,30] + pas de déduction → `true` → bouton auto
- Lot mixte (`_madFiable=false`) → saisie manuelle obligatoire
- Guard anti re-flag : `mad_reel_source='CSV Airbnb complexe / validation manuelle'` → Check D retourne silencieusement aux imports suivants (ne re-compare pas contre `_payoutMAD` du lot)
- `_payoutMAD` de lot mixte n'est jamais écrit directement — seule la valeur validée par l'utilisateur est stockée

#### DB cleanup appliqué (2026-06-04)

- `HMPJ5EQJZA-AIRC` (id=`mpgzdywi1wlk`) : `mad_reel/taux_reel/mad_reel_source/mad_reel_updated_at → NULL` (nettoyé avant la correction finale)
- Cause initiale : `fixDMadAnomaly` avait écrit `mad_reel=1423.94` avec `_payoutMAD` de lot contaminé (920.22 + 503.72 accumulés)
- État attendu après correction complète : `mad_reel=920.22, taux_reel=10.7002, mad_reel_source='CSV Airbnb payout'` (bouton auto disponible après Ctrl+F5)

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
// MAJ 2026-06-04 : AIRCOVER et AJUSTEMENT ajoutés à la liste éligible
var MAD_REEL_ELIGIBLE = ['RESERVATION','ANNULATION_PAYEE','RELOCATION','AIRCOVER','AJUSTEMENT'];
function rNetMAD(r)  { return r.mad_reel != null && MAD_REEL_ELIGIBLE.indexOf(r.type_norm)>=0 ? r.mad_reel : (r.net||0)*EUR_MAD; }
function rBrutMAD(r) { return r.taux_reel != null && MAD_REEL_ELIGIBLE.indexOf(r.type_norm)>=0 ? (r.brut||0)*r.taux_reel : (r.brut||0)*EUR_MAD; }
function rComMAD(r)  { return r.taux_reel != null && MAD_REEL_ELIGIBLE.indexOf(r.type_norm)>=0 ? (r.commission||0)*r.taux_reel : (r.commission||0)*EUR_MAD; }
function sumNetMAD(rows) { return rows.reduce(function(s,r){ return s+rNetMAD(r); },0); }
```

Utilisés dans : `computePeriodKPIs` (netMad, netMadAtt), `renderDash` (brut, com, sparklines, recap appart/source, décisions rapides), `renderResa` (totaux entête, ADR, recap par appart).

KPI impactés par `mad_reel` : CA encaissé, CA en attente, ADR, RevPAN, résultat net, marge.
Les totaux par appartement (`sumNetMAD(filter appart)`) et par source (`sumNetMAD(filter source)`) utilisent la même fonction.

### Règle d'affichage — ne JAMAIS modifier

- `net / brut / commission` en base = toujours EUR → **jamais touchés**
- `e2m()` / `fmtE()` = fonctions globales EUR×EUR_MAD → **inchangées**, utilisées pour Booking.com / VRBO / Direct
- AIRCOVER et AJUSTEMENT : fallback EUR×EUR_MAD si `mad_reel = null`, sinon `mad_reel` (après validation Réconciliation)

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
SMOOBU_API_KEY     → Smoobu API (lecture messages + envoi). Nouvelle clé usr_live_… si signature HMAC active.
SMOOBU_API_SECRET  → (optionnel avant 25/09/2026, OBLIGATOIRE après) secret de signature HMAC-SHA256.
                     Si présent → toutes les requêtes Smoobu sont signées (voir helper smoobuFetch).
                     Doit être défini EN MÊME TEMPS que SMOOBU_API_KEY=usr_live_… (la nouvelle clé exige la signature).
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

### UI — liste accordéon (refonte UX 2026-06-12, `7f922d1`)
- Chaque thread = carte accordéon : **en-tête compact cliquable** (voyageur, badges classification/`🌐 langue` (si ≠ fr)/`⚠ à regénérer` (stale)/Prospect/⚠ erreur, aperçu `client_summary_fr || message_content` 1 ligne ellipsis, heure, chevron) + **corps replié par défaut** (`#msgbody-<id>`) contenant tout le détail historique (contexte appart/source/booking#, résumé FR, message original, brouillon `#draft-<id>`, traduction, instruction `#instr-<id>` + 🎤 + Regénérer, actions).
- `msgToggleCard(id)` : bascule **DOM pure** (jamais de re-render → les brouillons édités dans les textareas des autres cartes sont préservés), ouverture exclusive (une seule carte ouverte), `MSG_OPEN_ID` survit aux re-renders, auto-dépli si un seul message affiché.
- Les ids et fonctions d'action (`msgSend`/`msgRegenerate`/`msgIgnore`/`msgResolve`/`msgToggleMic`) sont inchangés — tous les garde-fous (stale, texte vide, anti double-clic, confirm) intacts.

### Faits structurels Smoobu (audit 2026-06-12, CORRIGÉ 2026-07-02)
- **⚠️ CORRECTION 2026-07-02 — l'API Smoobu EXPOSE bien les messages de l'hôte** via le paramètre `onlyRelatedToGuest=false` (indiqué par le support Smoobu). Sans le paramètre, `/reservations/{id}/messages` ne renvoie que type=1 (guest) — d'où l'audit erroné du 2026-06-12. AVEC `?onlyRelatedToGuest=false`, le fil complet remonte (type=1 voyageur + type=2 hôte, y compris les réponses tapées dans Airbnb/Booking/Smoobu). Vérifié sur booking 140560917 : 11 msgs (0 hôte) → 25 msgs (15 hôte). Le paramètre est désormais appliqué dans `getSmoobuMessages()`. **Conséquence** : la détection `hostRepliedAfter` (webhook + sync) est de nouveau FONCTIONNELLE → auto-résolution des pending quand Hakim a déjà répondu sur la plateforme.
- **Smoobu n'envoie ses webhooks qu'à UNE seule URL** (celle des résas) : les `newMessage` arrivaient sur `smoobu-webhook.js` et étaient jetés ("action non gérée") → 100% des messages créés au cron 8h (latence jusqu'à 24h, prouvé par les created_at en base tous à 08:1x-08:5x UTC).
- **Prospects — CONFIRMÉ par le support Smoobu (Eva, 2026-07-03) — NE PAS RÉ-INVESTIGUER** : Smoobu n'a **aucun accès** aux pré-réservations ni aux messages envoyés **avant** qu'une réservation soit faite. Impossible de les récupérer via l'API tant que la résa n'est pas confirmée sur Airbnb. Les threads exigent tous `t.booking.id` (aucune conversation sans booking). **MAIS** : dès qu'un prospect **confirme** sa réservation, ses messages d'avant-réservation sont **importés** dans Smoobu → ils remontent alors dans le CRM (rien de perdu pour les clients qui convertissent). Pour les prospects qui ne réservent PAS : messages visibles uniquement dans l'app Airbnb/Booking, y répondre directement. Aucun contournement API possible (Airbnb/Booking n'exposent pas d'API messagerie hôte hors partenaires officiels).
- **Booking.com** : couvert par le scan direct du sync (section 4 — GET messages sur les résas Booking récentes, car Booking ne remonte pas dans /threads automatiquement). Les règles P1/P2 s'appliquent aux deux plateformes.

### Fixes P1/P2 (2026-06-12, `a967d7f` + `604d742`)
- **P1 latence 24h → secondes** : `case 'newMessage'` dans smoobu-webhook.js → forward HTTP vers `/api/smoobu-messages` (checkDuplicate protège du double traitement) ; maxDuration webhook 10→30s (analyse Claude dans le flux) ; badge Messages auto-rafraîchi toutes les 5 min côté CRM (`refreshMsgBadge`, requête légère qui ne touche jamais MSG_DATA ni la vue).
- **P2 hygiène** : au début de chaque sync, expiration automatique des pending > 48h (Hakim répond toujours < 1h sur la plateforme → un pending vieux = déjà traité) — `resolved`, ou `ignored` si no_reply_needed ; les messages classés `no_reply_needed` par Claude (pas seulement la regex triviale) sont archivés d'office (`ignored`) sur les 4 chemins insert/update ; nettoyage one-shot des 8 zombies en base le 2026-06-12 (0 pending restant).
- **Backlog P3 — LIVRÉ (voir section 16b ci-dessous pour l'état complet 2026-06-14→18).**

---

## 16b. Module Messages IA — Évolution majeure 2026-06-14 → 2026-06-18 (état ACTUEL, prod)

> Tout ce qui suit est **déployé et vérifié en réel**. C'est l'état courant du module — prioritaire sur les descriptions plus anciennes de la section 16.

### Architecture intelligence (prompt `generateFullAnalysis` + helpers, `api/smoobu-messages.js`)
- **Base de connaissances par logement** : colonne `logements.kb` (jsonb). Éditeur « 🤖 Fiche IA » par logement (vue Logements). `getApartmentKB(nom)` (match EXACT sur `logements.nom`) + `kbBlock(kb)` injecte titre/wifi/adresse+étage/**gmaps**/check-in-out/accès/parking/équipements/services+tarifs/règles/**faq** + RÈGLE ABSOLUE code serrure (jamais donné) + RÈGLE liens (n'invente jamais d'URL maps). 4 fiches Touahri/Agdal/Al Boustane/Riad pré-remplies (piscine Touahri = été 15/06-10/09, baignade **<14 ans**, adultes interdits, dans `faq`).
- **`globalPlaybook()`** (politiques communes : avant-résa, documents/check-in marocain, personnes déclarées, papier WC, équipements [pas d'aspirateur → balai+raclette ; **clim 3€/nuit optionnelle**], localisation, escalade, jamais d'envoi auto) + **`hakimStyleGuide()`** (voix de Hakim).
- **STYLE = brièveté DOMINANTE** : règle N°1 « 1-3 phrases, droit au but », INTERDIT bienvenue émotionnelle (« quelle joie de vous accueillir ») + clôtures non demandées ; consigne Hakim = exécute EXACTEMENT et rien d'autre. **LEÇON** : le few-shot (`getHakimStyleExamples` = ses réponses `sent`) enseignait le bla-bla → `styleBlock` dit « imite le ton PAS la longueur, la brièveté prime ».
- **SALUTATION par PRÉNOM obligatoire** : `guestFirstName(voyageur)` injecté en RÈGLE ABSOLUE N°1 (« Bonjour <Prénom> », jamais « Bonjour » seul), prime sur les exemples. **VRAIE CAUSE d'un échec long** = `manualDraft` passait `voyageur:''` EN DUR → le prénom n'atteignait jamais le prompt. Fix : voyageur transmis depuis le frontend (`cur.voyageur` / `_MANUAL_CLIENT.voyageur`).
- **PERTINENCE / RECENCY (capital)** : les réponses de Hakim sur Airbnb/Booking/Smoobu sont **INVISIBLES** (seules ses réponses via CRM sont vues). Donc logique par le **TEMPS** : l'IA répond UNIQUEMENT au dernier groupe récent ; tout message hors de la dernière heure = déjà traité (Hakim répond <1h en journée) → contexte, ne pas y répondre. **Rafale** : plusieurs msgs voyageur rapprochés (≤90 min, sans réponse Hôte entre) = traités comme UN SEUL. Frontend `_convLoad` calcule `cur.convFull` (fil voyageur + réponses CRM + dates relatives) et `cur.lastGuest` = la rafale ; `convGenerate` envoie message=rafale + conversation=fil complet. `buildGuestTranscript` (webhook) ajoute les dates relatives.
- **Phase du séjour** (`stayPhase`) + composition (adultes/enfants) injectées partout.
- **Ne JAMAIS dire « je vérifie »** si l'info figure déjà dans la fiche/playbook (même si on demande « est-ce toujours d'actualité »).
- Modèle : **`claude-haiku-4-5-20251001`** (léger). Option future : basculer le SEUL appel brouillon vers Sonnet (~10× coût) si la nuance manque — garder haiku pour traduction/vision.

### Endpoints `api/smoobu-messages.js` (ajouts)
- `POST ?manualDraft=1` — brouillon depuis un message OU une simple consigne (message proactif) ; accepte `conversation`, `voyageur`, `appart`, `instruction`, dates, compo.
- `POST ?sendDirect=1 {booking_id,text,...}` — envoie via Smoobu + INSERT `statut=sent` (apparaît dans le fil). **Tout envoi = clic + confirm(), jamais auto.**
- `POST ?reword=1` (reformule le texte de Hakim), `POST ?assist=1 {mode:refine|advise}` (affiner / conseiller sans réécrire), `POST ?translate=1` ({texts}→FR+langue détectée / {text,to}→langue client).
- `GET ?conversation=BOOKING_ID` (fil voyageur Smoobu + réponses CRM `sent`), `GET ?recentConversations=1[&date=YYYY-MM-DD]` (20 derniers fils, ou jusqu'à 100 d'un jour donné).
- **`POST ?analyzeImage=1` (Claude Vision)** : lit une PHOTO (haiku-4-5 supporte la vision). Image redimensionnée client à **1024px JPEG q0.8** (tokens réduits) → `analyzeImageMessage()` (`temperature:0`, prompt « décris UNIQUEMENT le visible, n'invente rien, si ambigu DEMANDE au voyageur ») → `{description_fr, classification, ai_draft, ai_draft_fr}`. Confidentialité : pièces d'identité → jamais retranscrire les numéros.

### UI Messages IA (`vw-messages` + modal conversation `conv-ov` + modal IA Manuelle)
- **Mobile** : modal conversation en **PLEIN ÉCRAN** (`height:100dvh`, layout WhatsApp). Débordement horizontal réglé par `#app,.content{overflow-x:clip}` + `.content{min-width:0}` en `@media(max-width:700px)` (**piège flexbox : un flex item `min-width:auto` + contenu non-rétrécissable [select/input date natif, longue URL] élargit la page → modal `position:fixed` élargi ; `clip` masque mais `min-width:0` corrige la largeur**).
- **Génération jamais bloquée** : `convGenerate` réinitialise toujours le placeholder ; si l'IA juge « aucune réponse nécessaire » → message clair (pas de spinner mort). Régénérer sur case vide + consigne → `convGenerate(instr)` (pas `assist` qui exigeait un brouillon).
- **Cases dynamiques (auto-grow)** : `convAutoGrow(el,max)` sur réponse + consignes (conv-instr passé en `<textarea>`) + champs IA Manuelle ; plafond + ≤45% écran.
- **Conversation** = 1 micro (sur les consignes), Envoyer + Régénérer pleine largeur.
- **Liste** : bloc « 🔴 À traiter » (pending, tri `created_at` desc) EN HAUT ; recherche + **filtre 📅 Date** + « Conversations récentes » (cartes type WhatsApp : nom + date visible + aperçu 2 lignes) en dessous.
- **IA Manuelle** : 2 usages (répondre à un message reçu OU écrire un message à partir d'une consigne) ; bouton 📷 Photo ; **champ Logement = menu DÉROULANT** peuplé depuis `DB.logements` (nom exact = clé fiche IA, zéro faute de frappe) ; champ Client/réservation (autocomplete → cible le booking pour l'envoi). Bandeau rouge 🚩 « relis bien avant d'envoyer » pour classif sensible/conflit/remboursement.

### HEAD prod au 2026-06-18 : `bdfa31e` (+ suivants éventuels). Backup : `nex-estate-crm-BACKUP-2026-06-18.zip`.

### Mobile
- Section Messages IA accessible via le drawer "Plus" → `mn-messages` (admin only)
- L'en-tête compact accordéon règle l'essentiel du confort mobile (plus de mur de cartes dépliées)

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

---

## 18. Module CA Airbnb réel — Services additionnels plateforme (stabilisé 2026-06-06)

### Objectif

Permettre de comparer le CRM avec le tableau de bord Airbnb en incluant les services additionnels payés via la plateforme (clim, late check-out, parking, extras voyageur...) dans un KPI "CA Airbnb réel", sans double-comptage et sans impacter le CA principal.

### Champ `pay_source` dans `serv`

| Valeur | Signification | `pay` stocké | `col` stocké |
|---|---|---|---|
| `null` | Terrain / Direct — paiement cash ou virement direct | valeur du select | valeur du select |
| `'Airbnb'` | Service encaissé via Airbnb — virement plateforme | `null` | `null` |
| `'Booking'` | Service encaissé via Booking.com (futur) | `null` | `null` |
| `'Autre'` | Autre mode — préciser via `pay` | valeur du select | `null` |

**Migration Supabase appliquée :** `ALTER TABLE serv ADD COLUMN IF NOT EXISTS pay_source text`

**Règle formulaire :** quand `pay_source = 'Airbnb'` ou `'Booking'` →`ff-serv-pay` et `ff-serv-col` masqués dans le formulaire ; `saveServ()` force `pay=null, col=null`.

### Calcul `extrasAirbnbPayes` dans `renderDash()`

```javascript
var extrasAirbnbPayes = filterPer(DB.serv, 'd').filter(function(r) {
  if (r.pay_source !== 'Airbnb') return false;
  if (r.statut !== 'Payé') return false;
  if (fa && r.appart !== fa) return false;
  // Anti-doublon V1 : exclure si resa_ref → AIRCOVER ou AJUSTEMENT dans DB.resa
  if (r.resa_ref) {
    var _linked = DB.resa.find(x => x.source==='Airbnb'
      && ['AIRCOVER','AJUSTEMENT'].indexOf(x.type_norm) >= 0
      && airbnbBaseRef(x.ref) === airbnbBaseRef(r.resa_ref));
    if (_linked) return false;
  }
  return true;
}).reduce((s, r) => s + (r.montant || 0), 0);
```

- `filterPer(DB.serv, 'd')` = même période que le dashboard (clé 'd')
- Filtre `statut='Payé'` uniquement (pas les En attente)
- Anti-doublon V1 : si `resa_ref` pointe vers un AIRCOVER/AJUSTEMENT dans DB.resa → exclu (déjà dans le CA via `sumNetMAD`)

### Calcul `caAirbnbReel`

```javascript
// Calculé APRÈS revRes pour cohérence de signe (revRes = même base que carte source)
var _caResaAirbnb = sumNetMAD(revRes.filter(r => r.source === 'Airbnb'));
var caAirbnbReel  = _caResaAirbnb + extrasAirbnbPayes;
```

**Règle immuable :** `_caResaAirbnb` doit toujours être calculé à partir de `revRes` (défini ligne ~3490), jamais depuis `_revPayeDash` (ligne ~3290) — cela garantit la cohérence de signe avec la carte "Répartition par source".

### Affichage Dashboard

| Zone | Contenu | Condition |
|---|---|---|
| KPI `kc-airbnb-reel` (grille `.kg`) | "CA Airbnb réel ⓘ" + valeur + "Resa X MAD + extras Y MAD" | `extrasAirbnbPayes > 0` |
| Carte Airbnb "Répartition par source" | "Réel Airbnb : X MAD" (orange, gras) + "dont Y MAD extras" | `extrasAirbnbPayes > 0` |
| Dec-card "Meilleure source" | "Réel : X MAD" (orange, gras) sous le CA réservations | Airbnb = meilleure source ET `extrasAirbnbPayes > 0` |

**Aucun de ces affichages ne modifie le CA principal (`netMad` / `computePeriodKPIs`).**

### Distinctions importantes

| KPI | Ce qu'il mesure | Fonction |
|---|---|---|
| CA encaissé | Toutes réservations Airbnb+Booking+Direct+VRBO (CA brut MAD) | `sumNetMAD(revPaye)` dans `computePeriodKPIs` |
| CA réservations Airbnb | Réservations Airbnb uniquement (via `revRes`) | `_caResaAirbnb` |
| Extras collectés | Tous services additionnels, tous statuts | `sum(DB.serv, 'montant')` |
| Services payés | Tous services statut=Payé | `servPaye` |
| **CA Airbnb réel** | Resa Airbnb + extras Airbnb payés (sans doublon) | `caAirbnbReel` |

### Modal "🏷 Plateformes" — mise à jour historique

- Bouton dans le header Services Additionnels (admin uniquement)
- Overlay `plat-fix-ov` (z-index:905)
- `openPlatFixModal()` : scanne `DB.serv` pour `pay_source=null && resa_ref`, croise avec `DB.resa` via `airbnbBaseRef`, pré-coche les lignes Airbnb
- `applyPlatFix()` : PATCH `pay_source='Airbnb', pay=null, col=null` sur les lignes cochées uniquement — aucune mise à jour automatique massive
- Les lignes sans `resa_ref` ne sont jamais proposées dans le modal

### Règle anti-doublon — ne jamais modifier

Si un service a `resa_ref` pointant vers une ligne `DB.resa` de type `AIRCOVER` ou `AJUSTEMENT` → le montant est déjà dans le CA via `rNetMAD()` → exclure de `extrasAirbnbPayes`.

### Ce qu'il ne faut JAMAIS toucher

- `findServMatch()` — la Réconciliation continue à reconnaître les services Airbnb comme `A_SERV` (vert) indépendamment de `pay_source`
- `computePeriodKPIs()` — pas de `serv` injecté dans le CA principal
- `isRevRow()` / `sumNetMAD()` / `rNetMAD()` — inchangés
- Les données des anciens services (`pay_source=null`) — comportement inchangé (inclus dans "Extras collectés", exclus de `extrasAirbnbPayes`)

---

## 19. Module Dépenses Perso — Architecture complète (stabilisé 2026-06-06)

### Vue d'ensemble

Module admin-only de gestion des dépenses personnelles. Table `perso` dans Supabase. Vue `vw-perso` dans le CRM. Fonctions clés : `renderPerso()`, `renderRecurPerso()`, `calcLissePerso()`.

### Table `perso` — colonnes

| Colonne | Type | Notes |
|---|---|---|
| `id` | text PK | `uid()` JS |
| `date` | text | Format `YYYY-MM-DD` |
| `cat` | text | Catégorie — CATS_P (22 items) |
| `desc` | text | Description libre |
| `montant` | numeric | Montant MAD |
| `rec` | text | Récurrence (info libre, non utilisé pour génération) |
| `statut` | text | `Payé` / `En attente` |
| `prest` | text | Prestataire (optionnel) |
| `don` | numeric NULL | Pourboire / don associé (toujours catégorisé Dons/Aides) |
| `recurring_charge_id` | text NULL | UUID de `recurring_charges` si généré automatiquement |
| `recurring_month` | text NULL | Format `YYYY-MM` — mois de génération |

### CATS_P — liste officielle (28 catégories : 22 courantes + 6 invest, IMMUABLE)

```javascript
// 22 dépenses courantes (budget mensuel)
var CATS_P_COURANT = [
  'Crédit personnel','Loyer perso','Pension enfants','Famille / Femme',
  'Crèche / École','Enfant / Loisirs enfant','Abonnements',
  'Alimentation / Grande surface','Resto / Snack / Café',
  'Maison / Réparations / Électroménager','Charges foyer',
  'Voiture / Entretien','Transport / Carburant','Médicaments',
  'Compléments alimentaires','Hygiène / Bien-être','Cotisations / Assurances',
  'Vêtements','Sport / Salle','Loisirs / Sorties','Dons / Aides','Autre perso'
];
// 6 catégories Patrimoine / Investissement (VEFA…) — ajouté 2026-06-26
var CATS_P_INVEST = [
  'VEFA – Avance appartement','VEFA – Frais notaire','VEFA – Frais dossier / banque',
  'VEFA – Ameublement initial','VEFA – Travaux / finitions','Autre investissement perso'
];
function isInvestPerso(cat){ return CATS_P_INVEST.indexOf(cat) >= 0; }
var CATS_P = CATS_P_COURANT.concat(CATS_P_INVEST);
```

**Source unique de vérité** pour le formulaire d'ajout ET le filtre catégorie. Ne jamais dupliquer cette liste.

### Patrimoine / Investissement perso (VEFA…) — séparation budget courant (ajouté 2026-06-26)

Objectif : ne pas mélanger les dépenses de vie courante avec les achats patrimoniaux (avances VEFA, notaire, ameublement initial…).

- **Pas de migration Supabase** — la nature est portée par la catégorie (`cat`), détectée via `isInvestPerso(cat)`.
- **Formulaire d'ajout** (`fi-cat`, ~ligne 8867) : select scindé en 2 `<optgroup>` — « ── Dépenses courantes ── » / « ── Patrimoine / Investissement ── ».
- **KPIs `renderPerso()`** : le hero **« Dépenses courantes »** (ex « Total période ») + Famille + Crédits/Loyer + En attente sont calculés sur `rowsCour` (= `rows.filter(r => !isInvestPerso(r.cat))`). **Le budget mensuel ne compte JAMAIS les VEFA.** Rangée `p-kg-invest` (affichée seulement si VEFA dans la période) : `p-invest` (🏗 Investissements/Patrimoine) + `p-gen` (Total général perso = courantes + investissements).
- **Résumé catégories** (`p-recap`) : helper `_recapCat(cat,color)` ; les courantes en violet, puis section dédiée « 🏗 Patrimoine / Investissement perso » (orange) pour les VEFA.
- **Liste / pagination / doublons** : `rows` reste l'ensemble complet → les VEFA restent visibles et éditables.
- **Charges récurrentes** (`rcp-cat`) restreintes à `CATS_P_COURANT` → impossible de créer une charge récurrente VEFA → `calcLissePerso()` / budget lissé inchangés. VEFA hors `CATS_P_FIXED`.

### Règles métier Dons / Pourboires — IMMUABLES

- Le montant principal reste dans sa catégorie d'origine
- Le pourboire/don est stocké dans `don` et catégorisé dans `Dons / Aides`
- Le **Total période inclut montant + don** (non-Dons/Aides : `sum(montant) + sum(don)`)
- Les catégories restent séparées dans le résumé — aucun double-comptage

```javascript
// Calcul Total période (dans renderPerso)
var tot = fc === 'Dons / Aides'
  ? rows.reduce(function(acc,r){ return acc+(r.cat==='Dons / Aides'?(r.montant||0):(r.don||0)); }, 0)
  : sum(rows,'montant') + rows.reduce(function(acc,r){ return acc+(r.cat!=='Dons / Aides'?(r.don||0):0); }, 0);
```

### Charges récurrentes perso — table `recurring_charges`

Partagée avec les charges business. Discriminant : colonne `type text DEFAULT 'business'`.

| Valeur type | Module |
|---|---|
| `'business'` | Charges récurrentes business (inchangé) |
| `'perso'` | Charges fixes personnelles |

**Guard non-régression business :**
```javascript
// Dans getEligibleCharges() (business) :
if (r.type === 'perso') return false;

// Dans renderRecurAdmin() (business) :
var list = DB.recur.filter(function(r){ return r.type !== 'perso'; });
```

### Fréquences supportées

| Fréquence | Logique d'éligibilité (`getEligibleChargesPerso(mk)`) |
|---|---|
| `mensuelle` | Toujours éligible si actif + dans les dates |
| `trimestrielle` | `diffMoisRecur(mk, date_debut) % 3 === 0` |
| `annuelle` | `mk.slice(5,7) === date_debut.slice(5,7)` (même mois calendaire) |

```javascript
function diffMoisRecur(mk, dateDebut) {
  var pa = mk.split('-'), pb = dateDebut.split('-');
  return (parseInt(pa[0])-parseInt(pb[0]))*12 + (parseInt(pa[1])-parseInt(pb[1]));
}
```

### Génération dans `perso` — règles

- `statut = 'En attente'` (jamais 'À payer')
- `recurring_charge_id = String(r.id)` (text, pas uuid — évite les problèmes de type)
- `recurring_month = GEN_PERSO_MONTH` (format `YYYY-MM`)
- Anti-doublon récurrent : `recurring_charge_id + recurring_month` déjà existants → exclus
- Anti-doublon manuel : entrée manuelle dans le mois (`!recurring_charge_id`) avec même cat + montant ±10% → **exclue de la génération** (affichée en section "Ignorées")

### Critères anti-doublon manuel (génération + contrôle)

```javascript
// Entrées manuelles du même mois
var manualThisMonth = DB.perso.filter(function(p){
  return !p.recurring_charge_id && p.date && p.date.slice(0,7) === GEN_PERSO_MONTH;
});

// Est un doublon si :
var isDoublon = manualThisMonth.some(function(p){
  return p.cat === r.cat &&
         r.montant > 0 &&
         Math.abs((p.montant||0) - r.montant) / r.montant <= 0.1;
});
```

### calcLissePerso() — budget lissé (fonction partagée)

```javascript
function calcLissePerso() {
  if (!DB.recur || !DB.recur.length) return { lisse: 0, annTheo: 0 };
  var actives = DB.recur.filter(function(r){ return r.type === 'perso' && r.active; });
  var totMens = actives.filter(function(r){ return r.frequence === 'mensuelle'; })
                       .reduce(function(s,r){ return s + (r.montant||0); }, 0);
  var totTrim = actives.filter(function(r){ return r.frequence === 'trimestrielle'; })
                       .reduce(function(s,r){ return s + (r.montant||0); }, 0);
  var totAnn  = actives.filter(function(r){ return r.frequence === 'annuelle'; })
                       .reduce(function(s,r){ return s + (r.montant||0); }, 0);
  return {
    lisse:   totMens + totTrim / 3 + totAnn / 12,
    annTheo: totMens * 12 + totTrim * 4 + totAnn
  };
}
```

**Utilisée par :** `renderPerso()`, `renderRecurPerso()`, `updateGenPersoPreview()`. Ne jamais recalculer localement.

**Budget lissé = affichage uniquement.** Ne jamais créer de lignes en base pour lisser une charge annuelle/trimestrielle.

### Lecture KPIs Dépenses Perso (vue Mois)

**Rangée 1 — toutes périodes :**
- Total période (cash réel + dons)
- Famille (Pension + Famille/Femme + Crèche + Enfant/Loisirs)
- Crédits & Loyer
- En attente

**Rangée 2 — vue Mois uniquement (`p-kg-fixes`) :**
- **Charges fixes du mois** = entrées `recurring_charge_id` OU `cat ∈ CATS_P_FIXED` dans le mois courant
- **Budget lissé / mois** = `calcLissePerso().lisse`
- **Écart fixes vs lissé** = charges fixes réelles − budget lissé (vert ≤ 0, orange > 0)

```javascript
var CATS_P_FIXED = ['Abonnements','Crédit personnel','Loyer perso','Pension enfants',
                    'Crèche / École','Cotisations / Assurances','Sport / Salle','Charges foyer'];
```

### Contrôle doublons — `openPersoDupControl()`

Bouton "🔍 Doublons" dans le header `vw-perso`.

**Critère de suspicion (ordre ET) :**
1. Même mois + même cat + montant ±10%
2. ET (au moins une ligne a `recurring_charge_id` OU cat ∈ CATS_P_FIXED)
3. ET libellés similaires (`labelsAreSimilar`) — **sauf** si récurrent + montant identique exact

**Exception :** `recurring_charge_id` présent + montant exactement identique → suspect même sans libellé similaire (desc peut être vide ou divergent).

**Catégories exclues** si zéro récurrent impliqué : Resto, Dons/Aides, Alimentation, Loisirs/Sorties, Maison, Transport, Médicaments, Hygiène, Vêtements, Famille/Femme, Enfant/Loisirs, Autre perso.

**`labelsAreSimilar(a, b)` :**
```javascript
// Normalise : minuscules, sans accents, sans ponctuation
// Découpe en mots ≥ 3 chars, retire les stop-words
// ≥ 1 mot en commun → similaire
var LABEL_STOP_WORDS = {
  mens:1, mensuel:1, mensuelle:1, annuel:1, annuelle:1,
  trimestriel:1, trimestrielle:1, charge:1, charges:1,
  paiement:1, paiements:1, perso:1, personnel:1, personnelle:1
};
```

**Suppression :** uniquement les lignes explicitement cochées → `DELETE FROM perso WHERE id IN (ids)`. Aucune suppression automatique.

### Onglets période Dépenses Perso

`Jour / Semaine / Mois / Trim. / Année` — IDs : `ptj, pts, ptm, pttri, pta`

`filterPer(rows, 'p')` gère déjà `trimestre` et `annee`. `setPer('p', 'trimestre'/'annee')` inchangé.

### Ce qu'il ne faut JAMAIS toucher

- La logique dons/pourboires (champ `don`, calcul Total période)
- Les catégories CATS_P_COURANT (22) et CATS_P_INVEST (6) — stabilisées
- La séparation courant/investissement : le budget mensuel (p-tot/fam/crd/att) calculé sur `rowsCour` uniquement ; `isInvestPerso()` = source unique
- Les charges business et leur module (`getEligibleCharges`, `renderRecurAdmin`)
- Le statut généré : toujours `'En attente'` (jamais `'À payer'`)
- `recurring_charge_id` stocké en `text` (pas uuid) dans `perso`

### Historique Dépenses Perso (2026-06-06)

| Commit | Changement |
|---|---|
| Total période inclut dons | `sum(montant) + sum(don)` pour les lignes non-Dons/Aides |
| CATS_P 16→22 catégories | 6 nouvelles catégories, migration 13 lignes "Autre perso" |
| Filtre catégorie dynamique | `p-fcat` peuplé depuis CATS_P au lieu d'être hardcodé |
| Charges récurrentes perso | Module complet : table `recurring_charges` type=perso, génération, fréquences |
| Bloc rétractable | Bloc "Charges fixes" entre résumé catégories et filtres, mini KPIs toujours visibles |
| Tabs Trim / Année | Boutons `pttri` / `pta` dans Dépenses Perso |
| Anti-doublon génération | Exclut les doublons manuels à l'insertion, section "Ignorées" dans la prévisualisation |
| Contrôle doublons | Bouton 🔍 Doublons, détection affinée, suppression manuelle avec cases à cocher |
| Budget lissé | `calcLissePerso()`, rangée KPI contextuelle en vue Mois uniquement |

### Historique Dépenses Perso (2026-06-26)

| Changement | Détail |
|---|---|
| Patrimoine / Investissement perso | Catégorie principale + 6 sous-catégories VEFA (CATS_P_INVEST), helper `isInvestPerso()`, séparation budget courant / investissement sans migration Supabase |
| Formulaire | Select `fi-cat` scindé en 2 optgroups (courantes / patrimoine) ; charges récurrentes `rcp-cat` restreintes à CATS_P_COURANT |
| KPIs | Hero « Dépenses courantes » (courant only) + rangée `p-kg-invest` (Investissements + Total général perso) affichée si VEFA présent |
| Résumé catégories | Section dédiée « 🏗 Patrimoine / Investissement perso » (orange) sous les courantes |
