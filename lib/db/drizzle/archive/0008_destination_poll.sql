-- Add destination shortlist columns to projects.
-- Idempotent: each statement is guarded by IF NOT EXISTS so re-running is safe.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS destination TEXT,
  ADD COLUMN IF NOT EXISTS destination_poll_id INTEGER;
