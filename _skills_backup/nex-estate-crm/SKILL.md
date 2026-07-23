---
name: nex-estate-crm
description: >-
  Skill maître CRM Nex-Estate (location courte durée, Rabat/Salé). Règles métier,
  KPIs, devise EUR/MAD, structure de l'app, automatisations. Déclencher si :
  CRM, dashboard, KPI, réservations, annulations, taxe de séjour, ménage, extras,
  dépenses, revenus, marge, ADR, RevPAN, occupation, EUR, MAD, Smoobu, Airbnb,
  Booking, ou noms des logements (Agdal 13, Touahri 11, Riad Ahl Sala,
  Résidence Al Boustane). Ne pas déclencher pour l'import de fichiers (CSV/XLS).
---

# CRM Nex-Estate — Skill maître

Tu es l'expert métier de Nex-Estate. Tu exécutes directement — jamais d'instructions
manuelles à Hakim (il n'est pas technique et délègue toute l'exécution).

---

## ⚡ RÈGLE N°1 — COMMENCE TOUJOURS PAR LIRE LA SOURCE VIVANTE

**Ce fichier ne contient PAS les règles à jour. Il te dit où les trouver.**

Avant toute réponse métier, lis la source partagée dans Supabase
(projet `zjultuaqkzjupiiewxhy`, connecteur Supabase) :

```sql
SELECT domaine, contenu, maj_le FROM crm_contexte ORDER BY ordre;
```

Cette table est le **point de départ commun à Claude Code, Cowork et Claude Chat**.
Elle est mise à jour à chaque session de travail réelle.

Puis, selon le besoin :

| Ce que tu cherches | Où le lire |
|---|---|
| Infos d'un logement (wifi, accès, services, tarifs, règles, FAQ) | `SELECT nom, kb FROM logements WHERE actif;` |
| Règles de comportement de l'IA voyageurs | `globalPlaybook()` dans `api/smoobu-messages.js` (dépôt GitHub) |
| Historique technique, schéma DB, règles immuables | `CLAUDE.md` du dépôt `hakimharrasse-dot/nex-estate-crm` |
| Référentiel métier rédigé par Hakim | `nex_estate_socle_commun.md` + `nex_estate_fiches_logement.md` |
| Données vivantes (résas, dépenses, taxes) | Base Supabase (`resa`, `business`, `serv`, `taxe`, `perso`) |

**Si tu n'as pas accès au connecteur Supabase**, dis-le franchement à Hakim et
demande-lui les infos manquantes — ne réponds JAMAIS de mémoire sur un chiffre
ou une règle : les tarifs et procédures changent souvent.

---

## Repères stables (changent rarement — vérifier quand même si c'est décisif)

**Architecture** — `index.html` unique (vanilla JS, zéro framework) · API serverless Vercel ·
base Supabase (source officielle) · Smoobu = channel manager · PriceLabs = pricing ·
prod `nex-estate-seven.vercel.app` · déploiement par `git push origin main`.

**Devise (immuable)** — réservations stockées en **EUR**, dépenses/extras/taxe en **MAD**.
Conversion EUR→MAD **uniquement à l'affichage du dashboard**, jamais à l'import, jamais de
taux figé en base. Taux temps réel via **er-api.com** (⚠️ frankfurter.app est mort, ne plus l'utiliser).

**Les 4 logements actifs** (libellés EXACTS = clés de jointure, ne jamais reformuler) :
`Agdal 13` · `Résidence Al Boustane` (Rabat) · `Touahri 11` · `Riad Ahl Sala` (Salé).
`Studio Ocean` = archivé (restitué début février 2026) : visible sur janvier/début février 2026
uniquement, jamais après, jamais dans Smoobu.

**Taxe de séjour** — Booking.com UNIQUEMENT (Airbnb/Direct/VRBO = 0), hors CA (argent de l'État).
Calcul : `nuits × (adultes + enfants) × taux` — **les enfants comptent**.
Rabat 4 €/nuit/personne · Salé 2 €/nuit/personne.

**Commissions par défaut** — Booking 22 % · Airbnb 15,5 % · VRBO 18 % · Direct 0 %.
Toujours recalculer, ne jamais importer la commission Smoobu brute.

**date_paiement (immuable)** — Airbnb RESERVATION/ANNULATION_PAYEE/RELOCATION → checkin + 1 j ·
Airbnb AIRCOVER/AJUSTEMENT → saisie manuelle uniquement · Booking → jeudi suivant le checkout ·
VRBO → checkin + 7 j · Direct → date_creation. `mois_kpi` = `date_paiement.slice(0,7)`,
**jamais basé sur checkin**.

**Équipe ménage (cash terrain)** — Net à payer = ménage effectué + dépenses avancées
− taxe collectée − extras collectés. Ne JAMAIS mélanger avec le résultat net business.
`Avance caisse` et `Règlement terrain` sont exclues de tous les KPIs financiers.

---

## ⚠️ Pièges à vérifier avant d'agir

1. **RÈGLE DES 3 COPIES** — la logique métier des réservations existe en **trois**
   exemplaires : `lib/smoobu-normalizer.js` (webhook), `api/smoobu-poll.js` (cron de midi),
   `index.html` (import CSV). Toute correction de règle métier doit être appliquée dans
   **LES TROIS**, sinon le cron de midi ré-écrase silencieusement chaque jour.
   Deux récidives déjà constatées (detectSrc, taxe de séjour).
2. **Ne jamais modifier sans instruction explicite** : CA, `date_paiement`, `mois_kpi`,
   les KPIs et leur logique, les champs `mad_reel`/`taux_reel` réconciliés, le design du CRM.
3. **Billing IA** — crédit prépayé Anthropic, sans recharge automatique. À zéro, l'IA
   s'arrête **en silence**. Si « l'IA ne répond plus » : vérifier le solde et les logs Vercel
   AVANT de soupçonner le prompt.
4. **Déploiement** — `git push origin main` (auto-deploy Vercel). Le token CLI Vercel expire vite.

---

## Règle absolue

Ne jamais mélanger **performance business (KPI)** et **flux terrain (ménage, taxe, extras)**.

Les règles lues dans `crm_contexte` et dans la base priment sur tout ce fichier :
en cas de contradiction, **la base a raison** et il faut signaler l'écart à Hakim.
