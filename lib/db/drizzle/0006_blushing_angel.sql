-- Add source column; default 'manual' for new organizer-created action items.
ALTER TABLE "project_tasks" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'manual' NOT NULL;

-- Backfill: rows that were instantiated from a playbook template have a non-null
-- source_step key. Mark them 'playbook' so they are not confused with organizer-
-- created action items (which have source_step = null).
UPDATE "project_tasks" SET "source" = 'playbook' WHERE "source_step" IS NOT NULL;
