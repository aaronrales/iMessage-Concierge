-- Migration: create agent_config key-value table
-- Applied: 2026-07-15
-- Safe to re-run: CREATE TABLE IF NOT EXISTS is idempotent.
CREATE TABLE IF NOT EXISTS agent_config (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
