---
name: Drizzle meta journal reset
description: How to recover drizzle-kit generate after the meta/_journal.json is missing
---

## The situation
When `lib/db/drizzle/` migrations and `lib/db/drizzle/meta/` are archived/deleted,
`drizzle-kit generate` fails because it expects a `meta/_journal.json` to exist.

## Fix
Create a fresh empty journal before running generate:
```
mkdir -p lib/db/drizzle/meta
echo '{"version":"7","dialect":"postgresql","entries":[]}' > lib/db/drizzle/meta/_journal.json
cd lib/db && npx drizzle-kit generate --name 0000_baseline
```

**Why:** drizzle-kit treats the journal as the migration history ledger; it must exist even for the first migration.
**How to apply:** Any time drizzle migrations folder is wiped or archived for a fresh start.
