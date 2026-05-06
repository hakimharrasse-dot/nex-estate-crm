-- ============================================================
-- BACKUP SCHÉMA SUPABASE — Nex-Estate CRM
-- Projet : nex-estate-crm (zjultuaqkzjupiiewxhy)
-- Région : eu-west-1  |  PostgreSQL 17.6
-- Généré : 2026-04-30
--
-- Contient : tables, index, RLS, fonctions
-- Triggers publics : aucun (uniquement triggers système storage/realtime)
-- Vues publiques   : aucune
--
-- Usage : exécuter dans l'éditeur SQL Supabase (ou psql)
--         sur un projet vierge avec Auth activé
-- ============================================================


-- ============================================================
-- 0. EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- 0b. MISE À JOUR DU SCHÉMA (post-backup 2026-04-30)
-- ============================================================
-- 2026-05-06 : colonne don ajoutée à perso
-- 2026-05-06 : tables logements et resa_backup_20260430 ajoutées
-- 2026-05-06 : RLS activé sur logements, resa_backup_20260426, resa_backup_20260430
-- 2026-05-06 : vue v_logements_actifs_par_mois recrée en security_invoker=true
-- ============================================================


-- ============================================================
-- 1. TABLES
-- ============================================================

-- ── resa ──────────────────────────────────────────────────────
-- Table principale des réservations (Smoobu + CSV + manuel)
CREATE TABLE IF NOT EXISTS public.resa (
  id              text          NOT NULL,
  ref             text,
  source          text,
  appart          text,
  voyageur        text,
  checkin         text,
  checkout        text,
  nuits_sejour    integer       DEFAULT 0,
  nuits_fact      integer       DEFAULT 0,
  nb_personnes    integer       DEFAULT 1,
  brut            numeric       DEFAULT 0,
  com_pct         numeric       DEFAULT 0,
  commission      numeric       DEFAULT 0,
  net             numeric       DEFAULT 0,
  taxe_sejour     numeric       DEFAULT 0,
  type_norm       text,
  mode_paiement   text,
  statut          text,
  date_paiement   text,
  mois_kpi        text,
  notes           text,
  created_at      timestamptz   DEFAULT now(),
  smoobu_id       text,
  date_creation   date,
  phone           text,
  email           text,
  guest_language  text,
  adults          integer,
  children        integer,
  override_manual boolean       DEFAULT false,
  nuits_business  integer,
  CONSTRAINT resa_pkey PRIMARY KEY (id)
);

-- ── resa_backup_20260426 ───────────────────────────────────────
-- Snapshot figé du 26 avril 2026 — ne pas modifier
CREATE TABLE IF NOT EXISTS public.resa_backup_20260426 (
  id             text,
  ref            text,
  source         text,
  appart         text,
  voyageur       text,
  checkin        text,
  checkout       text,
  nuits_sejour   integer,
  nuits_fact     integer,
  nb_personnes   integer,
  brut           numeric,
  com_pct        numeric,
  commission     numeric,
  net            numeric,
  taxe_sejour    numeric,
  type_norm      text,
  mode_paiement  text,
  statut         text,
  date_paiement  text,
  mois_kpi       text,
  notes          text,
  created_at     timestamptz,
  smoobu_id      text,
  date_creation  date,
  phone          text,
  email          text,
  guest_language text,
  adults         integer,
  children       integer
);

-- ── business ──────────────────────────────────────────────────
-- Dépenses et revenus business (liés aux appartements)
CREATE TABLE IF NOT EXISTS public.business (
  id                  text        NOT NULL,
  date                text,
  appart              text,
  cat                 text,
  fmen                text,
  "desc"              text,
  montant             numeric     DEFAULT 0,
  statut              text,
  created_at          timestamptz DEFAULT now(),
  scope               text        DEFAULT 'property',
  fmen_id             uuid,
  recurring_charge_id uuid,
  recurring_month     text,
  CONSTRAINT business_pkey PRIMARY KEY (id)
);

-- ── perso ──────────────────────────────────────────────────────
-- Dépenses personnelles (admin uniquement)
CREATE TABLE IF NOT EXISTS public.perso (
  id         text        NOT NULL,
  date       text,
  cat        text,
  "desc"     text,
  montant    numeric     DEFAULT 0,
  rec        text,
  statut     text,
  prest      text,
  created_at timestamptz DEFAULT now(),
  don        numeric     DEFAULT 0,  -- montant don/pourboire optionnel (ajouté 2026-05-06)
  CONSTRAINT perso_pkey PRIMARY KEY (id)
);

-- ── taxe ──────────────────────────────────────────────────────
-- Taxe de séjour (Booking.com)
CREATE TABLE IF NOT EXISTS public.taxe (
  id              text        NOT NULL,
  date            text,
  appart          text,
  voy             text,
  col             text,
  pay             text,
  montant         numeric     DEFAULT 0,
  rev             text,
  created_at      timestamptz DEFAULT now(),
  reservation_ref text,
  CONSTRAINT taxe_pkey PRIMARY KEY (id)
);

-- ── serv ──────────────────────────────────────────────────────
-- Services (ménage, maintenance…)
CREATE TABLE IF NOT EXISTS public.serv (
  id         text        NOT NULL,
  date       text,
  appart     text,
  svc        text,
  voy        text,
  col        text,
  pay        text,
  montant    numeric     DEFAULT 0,
  statut     text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT serv_pkey PRIMARY KEY (id)
);

-- ── profiles ──────────────────────────────────────────────────
-- Profils utilisateurs CRM (liés à auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid        NOT NULL,
  email      text        NOT NULL,
  full_name  text        NOT NULL DEFAULT '',
  role       text        NOT NULL DEFAULT 'user',
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz          DEFAULT now(),
  created_by uuid,
  CONSTRAINT profiles_pkey PRIMARY KEY (id)
);

-- ── team_members ──────────────────────────────────────────────
-- Membres de l'équipe (ménage, maintenance…)
CREATE TABLE IF NOT EXISTS public.team_members (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  phone      text,
  email      text,
  role       text        NOT NULL DEFAULT 'cleaner',
  active     boolean     NOT NULL DEFAULT true,
  notes      text,
  created_at timestamptz          DEFAULT now(),
  CONSTRAINT team_members_pkey PRIMARY KEY (id)
);

-- ── logements ─────────────────────────────────────────────────
-- Appartements actifs/archivés (ajouté post-backup 2026-04-30)
CREATE TABLE IF NOT EXISTS public.logements (
  id         text        NOT NULL,
  nom        text        NOT NULL,
  nom_smoobu text,
  ville      text,
  actif      boolean              DEFAULT true,
  date_debut date        NOT NULL,
  date_fin   date,
  notes      text,
  created_at timestamptz          DEFAULT now(),
  CONSTRAINT logements_pkey PRIMARY KEY (id)
);

-- ── resa_backup_20260430 ───────────────────────────────────────
-- Snapshot figé du 30 avril 2026 — ne pas modifier (même structure que resa)
CREATE TABLE IF NOT EXISTS public.resa_backup_20260430 (
  LIKE public.resa INCLUDING DEFAULTS
);

-- ── recurring_charges ─────────────────────────────────────────
-- Charges récurrentes (loyers, abonnements…)
CREATE TABLE IF NOT EXISTS public.recurring_charges (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  label       text        NOT NULL,
  cat         text        NOT NULL DEFAULT 'Loyer',
  montant     numeric     NOT NULL DEFAULT 0,
  scope       text        NOT NULL DEFAULT 'property',
  appart      text,
  frequence   text        NOT NULL DEFAULT 'mensuelle',
  jour        integer     NOT NULL DEFAULT 1,
  date_debut  date        NOT NULL,
  date_fin    date,
  active      boolean     NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz          DEFAULT now(),
  CONSTRAINT recurring_charges_pkey PRIMARY KEY (id)
);


-- ============================================================
-- 2. INDEX
-- ============================================================

-- resa
CREATE UNIQUE INDEX IF NOT EXISTS uq_resa_smoobu_id  ON public.resa (smoobu_id);
CREATE        INDEX IF NOT EXISTS idx_resa_appart     ON public.resa (appart);
CREATE        INDEX IF NOT EXISTS idx_resa_checkin    ON public.resa (checkin);
CREATE        INDEX IF NOT EXISTS idx_resa_mois_kpi   ON public.resa (mois_kpi);
CREATE        INDEX IF NOT EXISTS idx_resa_source     ON public.resa (source);
CREATE        INDEX IF NOT EXISTS idx_resa_statut     ON public.resa (statut);

-- business
CREATE INDEX IF NOT EXISTS idx_business_appart ON public.business (appart);
CREATE INDEX IF NOT EXISTS idx_business_date   ON public.business (date);

-- perso
CREATE INDEX IF NOT EXISTS idx_perso_date ON public.perso (date);

-- taxe
CREATE INDEX IF NOT EXISTS idx_taxe_appart          ON public.taxe (appart);
CREATE INDEX IF NOT EXISTS idx_taxe_date            ON public.taxe (date);
CREATE INDEX IF NOT EXISTS idx_taxe_reservation_ref ON public.taxe (reservation_ref);

-- serv
CREATE INDEX IF NOT EXISTS idx_serv_appart ON public.serv (appart);
CREATE INDEX IF NOT EXISTS idx_serv_date   ON public.serv (date);


-- ============================================================
-- 3. FONCTIONS
-- ============================================================

-- get_my_role() — retourne le rôle de l'utilisateur connecté
-- Utilisée dans toutes les politiques RLS
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT role FROM public.profiles
  WHERE id = auth.uid() AND active = true
  LIMIT 1;
$$;


-- ============================================================
-- 4. ROW LEVEL SECURITY (RLS)
-- ============================================================

-- Activer RLS sur toutes les tables métier
ALTER TABLE public.resa                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perso                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taxe                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.serv                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_charges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logements             ENABLE ROW LEVEL SECURITY;  -- ajouté 2026-05-06
ALTER TABLE public.resa_backup_20260426  ENABLE ROW LEVEL SECURITY;  -- ajouté 2026-05-06
ALTER TABLE public.resa_backup_20260430  ENABLE ROW LEVEL SECURITY;  -- ajouté 2026-05-06

-- ── resa ──────────────────────────────────────────────────────
CREATE POLICY resa_select ON public.resa
  FOR SELECT TO authenticated
  USING (get_my_role() IS NOT NULL);

CREATE POLICY resa_insert ON public.resa
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY resa_update ON public.resa
  FOR UPDATE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY resa_delete ON public.resa
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');

-- ── business ──────────────────────────────────────────────────
CREATE POLICY business_select ON public.business
  FOR SELECT TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY business_insert ON public.business
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY business_update ON public.business
  FOR UPDATE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY business_delete ON public.business
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');

-- ── perso ──────────────────────────────────────────────────────
CREATE POLICY perso_select ON public.perso
  FOR SELECT TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY perso_insert ON public.perso
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'admin');

CREATE POLICY perso_update ON public.perso
  FOR UPDATE TO authenticated
  USING (get_my_role() = 'admin');

CREATE POLICY perso_delete ON public.perso
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');

-- ── taxe ──────────────────────────────────────────────────────
CREATE POLICY taxe_select ON public.taxe
  FOR SELECT TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY taxe_insert ON public.taxe
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY taxe_update ON public.taxe
  FOR UPDATE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY taxe_delete ON public.taxe
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');

-- ── serv ──────────────────────────────────────────────────────
CREATE POLICY serv_select ON public.serv
  FOR SELECT TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY serv_insert ON public.serv
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY serv_update ON public.serv
  FOR UPDATE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY serv_delete ON public.serv
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');

-- ── profiles ──────────────────────────────────────────────────
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING ((id = auth.uid()) OR (get_my_role() = 'admin'));

-- Note : INSERT/UPDATE/DELETE sur profiles géré par /api/admin-users.js
--        via service_role (bypass RLS), pas via client JS

-- ── team_members ──────────────────────────────────────────────
CREATE POLICY team_select ON public.team_members
  FOR SELECT TO authenticated
  USING (get_my_role() IS NOT NULL);

CREATE POLICY team_insert ON public.team_members
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY team_update ON public.team_members
  FOR UPDATE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY team_delete ON public.team_members
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');

-- ── logements ─────────────────────────────────────────────────
CREATE POLICY logements_select ON public.logements
  FOR SELECT TO authenticated
  USING (get_my_role() IS NOT NULL);

CREATE POLICY logements_insert ON public.logements
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY logements_update ON public.logements
  FOR UPDATE TO authenticated
  USING  (get_my_role() = ANY (ARRAY['admin','manager']))
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY logements_delete ON public.logements
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');

-- ── resa_backup_20260426 ──────────────────────────────────────
CREATE POLICY backup_20260426_select ON public.resa_backup_20260426
  FOR SELECT TO authenticated
  USING (get_my_role() = 'admin');

-- ── resa_backup_20260430 ──────────────────────────────────────
CREATE POLICY backup_20260430_select ON public.resa_backup_20260430
  FOR SELECT TO authenticated
  USING (get_my_role() = 'admin');

-- ── recurring_charges ─────────────────────────────────────────
CREATE POLICY recur_select ON public.recurring_charges
  FOR SELECT TO authenticated
  USING (get_my_role() IS NOT NULL);

CREATE POLICY recur_insert ON public.recurring_charges
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY recur_update ON public.recurring_charges
  FOR UPDATE TO authenticated
  USING  (get_my_role() = ANY (ARRAY['admin','manager']))
  WITH CHECK (get_my_role() = ANY (ARRAY['admin','manager']));

CREATE POLICY recur_delete ON public.recurring_charges
  FOR DELETE TO authenticated
  USING (get_my_role() = 'admin');


-- ============================================================
-- 4b. VUES
-- ============================================================

-- v_logements_actifs_par_mois — nombre de logements actifs par mois KPI
-- security_invoker=true : le RLS de logements s'applique à l'appelant (ajouté 2026-05-06)
CREATE OR REPLACE VIEW public.v_logements_actifs_par_mois
  WITH (security_invoker = true)
AS
WITH mois AS (
  SELECT generate_series(
    '2025-01-01'::date::timestamptz,
    '2026-12-01'::date::timestamptz,
    '1 mon'::interval
  )::date AS mois
)
SELECT
  to_char(m.mois::timestamptz, 'YYYY-MM') AS mois_kpi,
  count(l.id)                              AS nb_logements_actifs,
  array_agg(l.nom ORDER BY l.nom)          AS logements
FROM mois m
JOIN logements l
  ON  l.date_debut <= (m.mois + '1 mon -1 days'::interval)::date
  AND (l.date_fin IS NULL OR l.date_fin >= m.mois)
GROUP BY m.mois
ORDER BY m.mois;

-- Permissions get_my_role() — révoquées du rôle anon (2026-05-06)
REVOKE EXECUTE ON FUNCTION public.get_my_role() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_my_role() TO authenticated;


-- ============================================================
-- 5. NOTES DE RECONSTRUCTION
-- ============================================================
--
-- Auth (Supabase Dashboard → Authentication) :
--   • Activer "Email" provider
--   • Désactiver "Email confirmation" (email_confirm=true géré par API)
--   • Créer le premier compte admin manuellement via le dashboard Auth,
--     puis insérer manuellement son profil :
--       INSERT INTO public.profiles (id, email, full_name, role, active)
--       VALUES ('<uuid_auth_user>', 'admin@exemple.com', 'Admin', 'admin', true);
--
-- Variables d'environnement Vercel (Settings → Environment Variables) :
--   SUPABASE_URL              → https://xxxx.supabase.co
--   SUPABASE_SERVICE_ROLE_KEY → clé service_role (Settings → API)
--   SMOOBU_API_KEY            → clé API Smoobu (Settings → Advanced → API Keys)
--   CRON_SECRET               → secret optionnel pour sécuriser /api/smoobu-poll
--   POLL_WINDOW_HOURS         → fenêtre polling en heures (défaut: 25)
--
-- Edge Function Supabase (smoobu-enrich) :
--   • Déployer depuis supabase/functions/smoobu-enrich/
--   • verify_jwt: false
--   • Secret header : x-enrich-token = NEX_ENRICH
--
-- Webhook Smoobu :
--   Smoobu → Settings → Advanced → API Keys → Webhook URLs
--   URL : https://<domaine>.vercel.app/api/smoobu-webhook
--
-- ============================================================
-- FIN DU FICHIER
-- ============================================================
