-- Migration: add admin_notes to threads and contact_card_sent to users
-- Applied: 2026-07-15
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS admin_notes text;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS contact_card_sent boolean NOT NULL DEFAULT false;
