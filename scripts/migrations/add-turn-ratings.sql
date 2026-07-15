-- Migration: create turn_ratings table
-- Applied: 2026-07-15
-- Safe to re-run: CREATE TABLE IF NOT EXISTS is idempotent.
CREATE TABLE IF NOT EXISTS turn_ratings (
  id            serial PRIMARY KEY,
  message_id    integer NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  thread_id     integer NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  rating        text NOT NULL,
  failure_tag   text,
  notes         text,
  rated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS turn_ratings_thread_id_idx ON turn_ratings (thread_id);
CREATE INDEX IF NOT EXISTS turn_ratings_rated_at_idx ON turn_ratings (rated_at DESC);
