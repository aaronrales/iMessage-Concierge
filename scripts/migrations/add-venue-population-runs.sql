-- Migration: add venue_population_runs table
-- Applied: 2026-07-15
-- Safe to re-run: CREATE TABLE IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS are idempotent.
CREATE TABLE IF NOT EXISTS venue_population_runs (
  id serial PRIMARY KEY,
  neighborhood text NOT NULL,
  borough text,
  city text,
  venue_type text NOT NULL DEFAULT 'restaurant',
  custom_query text,
  "limit" integer NOT NULL DEFAULT 20,
  status text NOT NULL DEFAULT 'pending',
  candidates_found integer,
  venues_written integer,
  venues_skipped integer,
  errors jsonb DEFAULT '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enforce at most one active (pending or running) row at the DB level.
-- Indexes a constant so only one row may satisfy the WHERE predicate at a time.
-- Any concurrent INSERT/UPDATE that would create a second active row raises error 23505.
CREATE UNIQUE INDEX IF NOT EXISTS venue_population_runs_one_active
  ON venue_population_runs ((1))
  WHERE status IN ('pending', 'running');
