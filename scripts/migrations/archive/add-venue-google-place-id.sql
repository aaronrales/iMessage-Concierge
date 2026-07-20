-- Migration: add google_place_id to venues
-- Applied: 2026-07-15
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_place_id text;
