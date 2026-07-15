#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply schema migrations idempotently. Targeted additive migrations (individual
# ALTER TABLE statements) run first so the column exists before the push sync.
psql "$DATABASE_URL" -f scripts/migrations/add-venue-google-place-id.sql
psql "$DATABASE_URL" -f scripts/migrations/add-message-delivery-log.sql
psql "$DATABASE_URL" -f scripts/migrations/add-turn-ratings.sql
psql "$DATABASE_URL" -f scripts/migrations/add-agent-config.sql
psql "$DATABASE_URL" -f scripts/migrations/add-thread-admin-notes-user-contact-card.sql
psql "$DATABASE_URL" -f scripts/migrations/add-venue-population-runs.sql
pnpm --filter db push
pnpm run typecheck:libs
