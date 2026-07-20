-- Headcount commitment round: new enum value and project columns.

-- Add commitment_nudge to the proactive message category enum.
-- ADD VALUE IF NOT EXISTS is safe on Postgres 9.3+ and idempotent.
ALTER TYPE "proactive_message_category" ADD VALUE IF NOT EXISTS 'commitment_nudge';

-- Add commitment round columns to projects table.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "commitment_deadline" timestamp with time zone;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "headcount_target" integer;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "commitment_poll_id" integer;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "headcount_locked_at" timestamp with time zone;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "headcount_locked_count" integer;
