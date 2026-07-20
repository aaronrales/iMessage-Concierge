-- Migration: create message_delivery_log table
-- Applied: 2026-07-15
-- Safe to re-run: CREATE TABLE IF NOT EXISTS is idempotent.
CREATE TABLE IF NOT EXISTS message_delivery_log (
  id            serial PRIMARY KEY,
  message_handle text,
  recipient_phone text,
  status        text NOT NULL,
  error_code    text,
  thread_id     integer REFERENCES threads(id) ON DELETE SET NULL,
  raw_payload   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_delivery_log_status_idx ON message_delivery_log (status);
CREATE INDEX IF NOT EXISTS message_delivery_log_created_at_idx ON message_delivery_log (created_at DESC);
