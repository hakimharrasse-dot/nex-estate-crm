-- ============================================================
-- BACKUP SCHÉMA SUPABASE — Nex-Estate CRM
-- Projet : zjultuaqkzjupiiewxhy | Région : eu-west-1 | PostgreSQL 17
-- Mis à jour : 2026-06-08 (ajout serv.note — migration add_note_to_serv)
-- ============================================================

-- ── TABLE : resa ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.resa (
  id                  text          NOT NULL PRIMARY KEY,
  ref                 text,
  source              text,
  appart              text,
  voyageur            text,
  checkin             text,
  checkout            text,
  nuits_sejour        integer       DEFAULT 0,
  nuits_fact          integer       DEFAULT 0,
  nb_personnes        integer       DEFAULT 1,
  brut                numeric       DEFAULT 0,
  com_pct             numeric       DEFAULT 0,
  commission          numeric       DEFAULT 0,
  net                 numeric       DEFAULT 0,
  taxe_sejour         numeric       DEFAULT 0,
  type_norm           text,
  mode_paiement       text,
  statut              text,
  date_paiement       text,
  mois_kpi            text,
  notes               text,
  created_at          timestamptz   DEFAULT now(),
  smoobu_id           text,
  date_creation       date,
  phone               text,
  email               text,
  guest_language      text,
  adults              integer,
  children            integer       DEFAULT 0,
  override_manual     boolean       DEFAULT false,
  nuits_business      integer,
  reconcile_ignored   boolean       DEFAULT false,
  mad_reel            numeric,
  taux_reel           numeric,
  mad_reel_source     text,
  mad_reel_updated_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.resa TO authenticated;

-- ── TABLE : business ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.business (
  id                  text          NOT NULL PRIMARY KEY,
  date                text,
  appart              text,
  cat                 text,
  fmen                text,
  desc                text,
  montant             numeric       DEFAULT 0,
  statut              text,
  created_at          timestamptz   DEFAULT now(),
  scope               text          DEFAULT 'property',
  fmen_id             uuid,
  recurring_charge_id uuid,
  recurring_month     text,
  paid_by             text,
  paid_by_id          uuid,
  date_reglement      text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business TO authenticated;

-- ── TABLE : taxe ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.taxe (
  id              text        NOT NULL PRIMARY KEY,
  date            text,
  appart          text,
  voy             text,
  col             text,
  pay             text,
  montant         numeric     DEFAULT 0,
  rev             text,
  created_at      timestamptz DEFAULT now(),
  reservation_ref text,
  note            text        DEFAULT NULL,
  asuivre_ignore  boolean     DEFAULT false
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.taxe TO authenticated;

-- ── TABLE : serv ─────────────────────────────────────────────
-- svc : peut contenir plusieurs services séparés par ", "
--       ex: "Arrivée anticipée, Climatisation" (multi-services depuis 2026-06-08)
-- note : détail libre optionnel — AJOUTÉ 2026-06-08 (migration add_note_to_serv)
-- pay_source : 'Airbnb' | 'Booking' | 'Autre' | null
-- resa_ref : référence réservation Airbnb — matching P0 Réconciliation
CREATE TABLE IF NOT EXISTS public.serv (
  id          text        NOT NULL PRIMARY KEY,
  date        text,
  appart      text,
  svc         text,
  voy         text,
  col         text,
  pay         text,
  montant     numeric     DEFAULT 0,
  statut      text,
  created_at  timestamptz DEFAULT now(),
  resa_ref    text,
  pay_source      text,
  note            text,
  asuivre_ignore  boolean     DEFAULT false
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.serv TO authenticated;

-- ── TABLE : perso ────────────────────────────────────────────
-- don : pourboire/don associé (ajouté 2026-05-06)
-- recurring_charge_id : TEXT (pas uuid — intentionnel, évite les problèmes de type)
CREATE TABLE IF NOT EXISTS public.perso (
  id                  text        NOT NULL PRIMARY KEY,
  date                text,
  cat                 text,
  desc                text,
  montant             numeric     DEFAULT 0,
  rec                 text,
  statut              text,
  prest               text,
  created_at          timestamptz DEFAULT now(),
  don                 numeric     DEFAULT 0,
  recurring_charge_id text,
  recurring_month     text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.perso TO authenticated;

-- ── TABLE : recurring_charges ─────────────────────────────────
-- type : 'business' | 'perso'
-- scope : 'global' | 'property'
-- frequence : 'mensuelle' | 'trimestrielle' | 'semestrielle' | 'annuelle'
CREATE TABLE IF NOT EXISTS public.recurring_charges (
  id          uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
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
  created_at  timestamptz DEFAULT now(),
  type        text        DEFAULT 'business'
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recurring_charges TO authenticated;

-- ── TABLE : team_members ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.team_members (
  id          uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  phone       text,
  email       text,
  role        text        NOT NULL DEFAULT 'cleaner',
  active      boolean     NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.team_members TO authenticated;

-- ── TABLE : logements ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.logements (
  id          text        NOT NULL PRIMARY KEY,
  nom         text        NOT NULL,
  nom_smoobu  text,
  ville       text,
  actif       boolean     DEFAULT true,
  date_debut  date        NOT NULL,
  date_fin    date,
  notes       text,
  created_at  timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.logements TO authenticated;

-- ── TABLE : messages ─────────────────────────────────────────
-- Module Messages IA (Smoobu webhook → Claude API → brouillon)
CREATE TABLE IF NOT EXISTS public.messages (
  id                   uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  smoobu_booking_id    bigint      NOT NULL,
  reservation_id       text,
  topic                text        NOT NULL,
  extension            text        NOT NULL,
  appart               text,
  voyageur             text,
  payload              jsonb,
  source               text,
  event                text,
  sender               text,
  private              boolean     DEFAULT false,
  message_content      text,
  ai_draft             text,
  ai_draft_fr          text,
  classification       text,
  detected_language    text,
  client_summary_fr    text,
  hakim_instruction    text,
  is_stale             boolean     DEFAULT false,
  smoobu_message_id    text,
  smoobu_api_response  text,
  statut               text        NOT NULL DEFAULT 'pending',
  sent_at              timestamptz,
  error_message        text,
  raw_payload          jsonb,
  inserted_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages TO authenticated;

-- ── RÈGLE CRITIQUE — GRANT sur toute nouvelle table ──────────
-- Depuis oct 2026, Supabase n'expose plus automatiquement les nouvelles tables.
-- Toujours ajouter après CREATE TABLE :
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.xxx TO authenticated;

-- ── MIGRATIONS APPLIQUÉES (ordre chronologique) ───────────────
-- 2026-04-28 : ALTER TABLE resa  ADD COLUMN IF NOT EXISTS nuits_business integer;
-- 2026-05-01 : ALTER TABLE resa  ADD COLUMN IF NOT EXISTS override_manual boolean DEFAULT false;
-- 2026-05-01 : ALTER TABLE resa  ADD COLUMN IF NOT EXISTS reconcile_ignored boolean DEFAULT false;
-- 2026-05-12 : ALTER TABLE resa  ADD COLUMN IF NOT EXISTS mad_reel numeric;
-- 2026-05-12 : ALTER TABLE resa  ADD COLUMN IF NOT EXISTS taux_reel numeric;
-- 2026-05-12 : ALTER TABLE resa  ADD COLUMN IF NOT EXISTS mad_reel_source text;
-- 2026-05-12 : ALTER TABLE resa  ADD COLUMN IF NOT EXISTS mad_reel_updated_at timestamptz;
-- 2026-05-06 : ALTER TABLE perso ADD COLUMN IF NOT EXISTS don numeric DEFAULT 0;
-- 2026-05-31 : ALTER TABLE serv  ADD COLUMN IF NOT EXISTS resa_ref text;
-- 2026-06-06 : ALTER TABLE serv  ADD COLUMN IF NOT EXISTS pay_source text;
-- 2026-06-06 : ALTER TABLE business ADD COLUMN IF NOT EXISTS scope text DEFAULT 'property';
-- 2026-06-06 : ALTER TABLE business ADD COLUMN IF NOT EXISTS recurring_charge_id uuid;
-- 2026-06-06 : ALTER TABLE business ADD COLUMN IF NOT EXISTS recurring_month text;
-- 2026-06-06 : ALTER TABLE business ADD COLUMN IF NOT EXISTS paid_by text;
-- 2026-06-06 : ALTER TABLE business ADD COLUMN IF NOT EXISTS paid_by_id uuid;
-- 2026-06-06 : ALTER TABLE business ADD COLUMN IF NOT EXISTS date_reglement text;
-- 2026-06-06 : ALTER TABLE perso  ADD COLUMN IF NOT EXISTS recurring_charge_id text;
-- 2026-06-06 : ALTER TABLE perso  ADD COLUMN IF NOT EXISTS recurring_month text;
-- 2026-06-06 : ALTER TABLE taxe   ADD COLUMN IF NOT EXISTS reservation_ref text;
-- 2026-06-08 : ALTER TABLE serv   ADD COLUMN IF NOT EXISTS note text DEFAULT NULL;
--              (migration : add_note_to_serv)
-- 2026-06-09 : ALTER TABLE taxe   ADD COLUMN IF NOT EXISTS asuivre_ignore boolean DEFAULT false;
--              (migration : add_asuivre_ignore_to_taxe)
-- 2026-06-09 : ALTER TABLE serv   ADD COLUMN IF NOT EXISTS asuivre_ignore boolean DEFAULT false;
--              (migration : add_asuivre_ignore_to_serv) ← DERNIÈRE MIGRATION
