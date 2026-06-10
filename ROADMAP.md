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

## 🔲 Reste à faire

1. **P3.11 Alerte webhook Smoobu** — badge nav si aucune sync depuis > 2h (~1-2h)
2. **P3.8 Mobile complet** — Réservations + Dashboard en priorité, commits séparés (gros chantier)

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
| Mobile | 55/100 | Desktop-first — mobile partiel |
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
