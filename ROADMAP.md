# Nex-Estate CRM — Roadmap & Audit 2026-06-08 (MAJ 2026-06-10)

> Audit complet réalisé le 2026-06-08. Score global : **73/100** → estimé **~85-88/100** au 2026-06-10.
> Ce document sert de roadmap pour les prochaines sessions.

---

## ✅ État au 2026-06-10 — fait depuis l'audit

- P1.1 Fix "null" collecteur (`e17ad7e`) · P1.2 Recherche Taxe/Services/Perso (`57952d4`) · P1.3 Taux EUR/MAD multi-source + cache + auto-lock (`b9005e9`→`8b1df0e`)
- P2.4 Multi-select Business (Commits A→E) · P2.5 Export CSV 4 vues (`cd7cf49`) · P2.6 Vue "À suivre" (`2517f54`→`f129756`) · P2.7 Barchart CA mensuel 12 mois (`9c6490d`)
- P3.9 Stats par appartement (`d4f754a`→`04acbd9`) · P3.10 Taxe de séjour auto-créée pour les résas Booking (`57952d4` session 06-09)
- Hors roadmap : **CA unifié** (resa+serv+taxe — dashboard, appartements, sources `681dd40`/`c5d7137`), note extras cash par client plateforme (`ed35a0c`), autocomplete Réservation liée Airbnb+Booking avec sync appartement/voyageur (`6487eeb`→`6f674ef`)
- Bug Faiz Remmache : réglé (plus de doublon)
- Audit `smoobu-enrich` : ✅ conforme — ne patch que voyageur/ref/lang/email/phone, jamais de champs financiers

- P3.11 Alerte sync Smoobu : ✅ fait 2026-06-10 (`654fb39`) — table `sync_heartbeat` (RLS read authenticated), `smoobu-poll.js` écrit un heartbeat à chaque run, badge rouge sidebar si > 2h
- Récap équipe : nb passages en attente + détail dépliable dates/appart/montant (`41947f4`)

## ✅ Dashboard "Mois à venir" (inspiré Smoobu) — livré 2026-06-12 (`f91c9f6`)

- Bloc 📅 M+1/M+2/M+3 : CA confirmé (`mois_kpi` futur via `sumNetMAD`), nuits réservées (`occupNightsBiz`), % occupation sécurisée (`computeJoursDispo`, `joursDispoAppart(ap,s,e)` si filtre appartement)
- Barchart : 12 mois passés + 3 futurs en barres translucides pointillées, légende "Confirmé à venir", labels italiques
- Lecture seule — aucun calcul KPI existant modifié ; respecte le filtre appartement du dashboard
- 🔲 Bloc 2 Smoobu (différé, validé dans le principe) : parts en % par source (CA, nuits, annulations) dans "Répartition par source"

## ✅ Thème clair/sombre 🌙/☀️ — livré 2026-06-12 (`dcc3677`)

- Palette claire `html.theme-light` : 17 variables surchargées, accents assombris pour le contraste sur fond blanc (--gr #2e8f5f, --go #a88a14, etc.)
- Script anti-flash dans `<head>` (classe posée sur documentElement avant le rendu)
- Persistance `localStorage['nex_theme']` ; boutons : sidebar desktop `#btn-theme` + drawer mobile `#mn-theme` ; `toggleTheme()`/`applyThemeLabels()`
- Couleurs en dur converties : loading-overlay (var(--bg)), dropdown suggestions resa_ref (var(--s)/var(--s2)/var(--br))
- Vérifié : Réservations/Dashboard/Services + modal + dropdown services + login, clair et sombre, 1280px et 390px, anti-flash au reload

## 🔲 Reste à faire — chantier UX globale (ouvert 2026-06-10, après clôture roadmap initiale)

1. **UX Messages IA** (60/100) : refonte UX du module — dernier item

## ✅ UX Lisibilité — livré 2026-06-12 (commits da53cfe → 1a7c428)

- `da53cfe` — **États vides actionnables** : icône + message + hint "Vérifie la période ou les filtres actifs" + bouton "+ Ajouter" contextuel (resa/business/taxe/serv/perso, desktop + mobile, helper `emptyStateHtml`)
- `6712e91` — **Hiérarchie KPIs** : classe `kc-hero` sur le KPI principal de chaque vue — valeur 23px desktop / 20px mobile + accent latéral couleur module (vert resa/dash, orange business, teal taxe, doré serv, violet perso)
- `1a7c428` — **Harmonisation Services** : colonne "Collecte" fusionnée comme Taxe (chip "Via Airbnb"/"Via Booking" pour pay_source, sinon collecteur + mode) — supprime le faux "Cash" affiché sur les extras plateforme

## ✅ UX globale — lot 3 desktop livré 2026-06-10 (commits 1d95810 → 9c5c68c)

- `1d95810` — **Retour en haut étendu au desktop** : bas droite (24px), hover orange ; gate `isMobile()` retiré du listener scroll
- `9c5c68c` — **Raccourcis clavier desktop** : `N` nouvelle entrée (vue active via `FAB_VIEWS[CUR]`), `/` focus recherche (`KBD_SEARCH` map), `Échap` ferme modal puis aide, `?` panneau d'aide auto-expirant 10s — guards : saisie en cours, modal ouvert, rôle user, login screen

## ✅ UX globale — lot 2 livré 2026-06-10 (commits dbf3f91 → c29f7d9)

- `dbf3f91` — **Extra lié depuis une résa** : bouton ⭐ sur cartes mobiles + lignes desktop Réservations → `addExtraForResa(id)` ouvre le modal Services pré-rempli (resa_ref, appartement si option existante, voyageur sauf infos manquantes Smoobu) ; `actBtns(type,id,extraHtml)` étendu avec slot optionnel
- `c29f7d9` — **Retour en haut mobile** : `#scrolltop-btn` bas gauche, listener scroll passif, visible si `scrollY>600 && isMobile()`, scroll smooth

## ✅ UX globale — lot 1 livré 2026-06-10 (commits a680b92 → 760dd77)

- `dabe09e` — fix(mobile) : Récap équipe en 1 colonne (2 colonnes illisibles — retour terrain Hakim)
- `a680b92` — **Feedback fiable** : `saveOne`/`deleteOne`/`upsert` retournent ok/échec ; `toastSaveResult()` → toast vert "✓ Enregistré" ou rouge 6s "⚠️ Erreur d'écriture — donnée NON sauvegardée en base" sur les 5 save* + delEntry ; confirm suppression enrichi (libellé + montant) ; toast au-dessus de la mobnav sur mobile. **Trou critique corrigé** : avant, une erreur Supabase n'était visible que dans db-status (sidebar masquée sur mobile)
- `4bb5e6f` — **FAB mobile "+ Ajouter"** : bouton flottant orange contextuel (resa/business/taxe/serv/perso), masqué rôle user et sur les autres vues, `updateFab()` dans `goTo()`
- `760dd77` — **Mémoire des derniers choix** : appartement + collecteur pré-remplis dans Taxe et Services (`lastChoice`/`setLastChoice`, clés `nex_last_appart`/`nex_last_col`) ; éditions existantes non touchées ; Business exclu volontairement (multi-chips appartement = risque de saisie sur le mauvais appart)

## ✅ P3.8 Mobile complet — fait 2026-06-10 (commits b2ba95a → 1456910)

- `b2ba95a` — Barre de filtres compacte toutes vues : grille CSS 2 colonnes <700px (multi-selects appairés 2×2, tabs/nav/sélecteur période/champs recherche sur ligne entière)
- `30be250` — Cartes Réservations : date checkout ajoutée (format court MM-DD si même année)
- `2130201` — Modals bottom-sheet pleine largeur (max-height 94dvh, coins arrondis haut) + inputs `.fi/.fse` à 16px (anti-zoom iOS au focus)
- `1456910` — Dashboard : cartes récap appartement/source en colonne, delta "vs mois préc." du Résultat net réel sur ligne dédiée, labels barchart 9px sur mobile (`_bfs` via `isMobile()`), filtre appartement pleine largeur
- Vérifié en preview locale 390×844 avec données factices (login bypassé) : Réservations, Dashboard, Business, Services + non-régression desktop 1280px, 0 erreur console

---

## Score par module

| Module | Score | Statut |
|---|---|---|
| Réservations + KPI Dashboard | 90/100 | Excellent — réconciliation MAD réel stable |
| Dépenses Business | 85/100 | Très bien — charges récurrentes + budget lissé |
| Dépenses Perso | 80/100 | Bien — 22 catégories, charges récurrentes, budget lissé |
| Réconciliation Airbnb | 85/100 | Stable — TYPES_OK, Check D, lot complexe |
| Réconciliation Booking | 80/100 | Stable — CSV + PDF |
| Services Additionnels | 75/100 | Bien — multi-services + note ajoutés 2026-06-08 |
| Réservations (filtres) | 80/100 | Bien — 4 filtres multi-select ajoutés 2026-06-08 |
| Messages IA | 60/100 | Fonctionnel mais UX basique |
| Mobile | 80/100 | Filtres grille 2 col, cartes complètes, modals bottom-sheet, dashboard adapté (2026-06-10) |
| UX globale | 60/100 | Fonctionnel, peu de polish |

---

## Items prioritaires (P1 — Quick wins)

### 1. Fix : "null" collecteur dans Services Additionnels
- **Problème** : quand `r.col` est null, l'affichage montre le texte littéral "null"
- **Fix** : `r.col || r.pay_source || 'Cash'` dans renderServ
- **Effort** : 15 min

### 2. Barre de recherche — modules manquants
- **Modules sans recherche texte** : Dépenses Perso, Taxe de séjour, Services Additionnels
- **Dépenses Business** : déjà `b-fsearch` (lié à)
- **Réservations** : déjà `r-search`
- **Effort** : 1h par module

### 3. Fix EUR/MAD taux fallback
- **Problème** : `frankfurter.app` peut échouer silencieusement → EUR_MAD reste à 10.50
- **Investigation** : vérifier les logs console, tester avec une alternative (ex: `api.frankfurter.dev`)
- **Effort** : 30 min investigation

---

## Items importants (P2 — Session prochaine)

### 4. Multi-select Business — Catégorie et Membre
- **Contexte** : Appartement, Statut, Payé par sont déjà mono-select ; Catégorie et Membre pourraient bénéficier du multi-select
- **Décision requise** : confirmer si utile avec l'usage réel
- **Précaution** : ne pas toucher aux fonctions msCat* existantes

### 5. Export CSV/Excel des tableaux
- **Modules concernés** : Réservations, Dépenses Business, Dépenses Perso, Services Additionnels
- **Fonctionnalité** : bouton "Exporter" → CSV compatible Excel (encodage UTF-8 BOM)
- **Effort** : 2-3h

### 6. Notifications En attente
- **Problème** : pas de visibilité sur les paiements "En attente" à venir
- **Idée** : badge dans la nav + section "À encaisser cette semaine"
- **Effort** : 2h

### 7. Dashboard — graphique évolution CA mensuelle
- **Actuellement** : KPIs statiques par période
- **Idée** : sparkline ou mini-graphique 6 derniers mois
- **Effort** : 3-4h

---

## Items moyen terme (P3)

### 8. Mobile — amélioration complète
- **Contexte** : CRM desktop-first, mobile CSS basique
- **Modules prioritaires** : Réservations (liste + modal), Dashboard
- **Règle** : toujours dans un commit séparé, jamais avec des fonctionnalités

### 9. Module Logements — statistiques par appartement
- **Actuellement** : liste simple actif/archivé
- **Idée** : CA YTD, taux occupation YTD, ADR, top voyageur par appart

### 10. Automatisation taxe de séjour
- **Actuellement** : saisie manuelle à chaque réservation Booking
- **Idée** : pré-remplissage automatique depuis la réservation (nuits × adultes × taux)
- **Précaution** : ne pas modifier le calcul existant si manual

### 11. Alertes remontée Smoobu
- **Idée** : badge dans nav si webhook inactif depuis > 2h
- **Effort** : 1-2h (heartbeat ping Supabase)

---

## Bugs connus / À surveiller

| Bug | Sévérité | Notes |
|---|---|---|
| "null" collecteur dans serv (r.col null) | Basse | Fix P1 ci-dessus |
| frankfurter.app timeout intermittent | Moyenne | EUR_MAD reste à 10.50 en fallback |
| Doublon Faiz Remmache (BKG-5125100938_q1) | Basse | À supprimer manuellement (checkin 2026-01-01 vide, pas de smoobu_id) |
| smoobu-enrich Edge Function : vérifier guard override_manual | Basse | Audit à faire |

---

## Décisions architecturales actées (NE PAS REMETTRE EN QUESTION)

| Décision | Raison |
|---|---|
| Dashboard appartement en mono-select | `fa` alimente `joursDispo`, `nAp`, `computePeriodKPIs()` — toucher = casser les KPIs |
| `perso.recurring_charge_id` en TEXT (pas uuid) | Évite les erreurs de type lors du génération |
| `business.recurring_charge_id` en UUID | Strict pour les charges globales — matching exact |
| `serv.svc` comma-separated (pas table séparée) | Rétrocompatibilité totale avec les mono-services |
| Commits séparés par fonctionnalité | Rollback facile — règle inviolable |
| Jamais combiner refactoring + nouvelle feature | Règle inviolable |

---

## Contraintes permanentes (règles Claude)

- Ne jamais toucher : CA, date_paiement, mois_kpi, KPI calculations
- Ne jamais toucher : Budget charges fixes, Ménage par appartement, Récap paiement & avances caisse
- Ne jamais toucher : mad_reel / taux_reel des réservations réconciliées
- Ne jamais toucher : design et layout général sans instruction explicite
- Ne jamais toucher : fonctions msCat*
- Desktop first — mobile dans un commit séparé

---

*Généré automatiquement le 2026-06-08 — à mettre à jour en fin de chaque session.*
