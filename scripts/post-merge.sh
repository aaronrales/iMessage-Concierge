#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply schema migrations idempotently. Targeted additive migrations (individual
# ALTER TABLE statements) run first so the column exists before the push sync.
psql "$DATABASE_URL" -f scripts/migrations/add-venue-google-place-id.sql
pnpm --filter db push
pnpm run typecheck:libs
