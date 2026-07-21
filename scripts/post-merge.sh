#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply any targeted additive migrations, if present (idempotent .sql files).
if compgen -G "scripts/migrations/*.sql" > /dev/null; then
  for f in scripts/migrations/*.sql; do
    psql "$DATABASE_URL" -f "$f"
  done
fi
# Sync schema from drizzle definitions.
pnpm --filter db push
pnpm run typecheck:libs
