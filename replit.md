# Concierge — AI iMessage Concierge

AI iMessage concierge for friend-group event planning. Express API + React ops dashboard. Sendblue for iMessage.

## Project Overview

Concierge lives inside iMessage. It joins 1:1 and group threads, learns each person through conversational onboarding, helps plan trips/dinners/meetups, runs group polls to reach consensus, manages playbook-driven projects (trips, bachelorettes, reunions), and handles budgets and bookings — all requiring human approval before anything is confirmed.

## Stack

- **Runtime:** Node.js 24, TypeScript 5.9, pnpm workspaces
- **API:** Express 5 + Drizzle ORM + PostgreSQL
- **Queue:** pg-boss (scheduled jobs, proactive sends)
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **LLM:** OpenAI via Replit AI Integrations proxy (`AI_INTEGRATIONS_OPENAI_*`), model `gpt-4.1-mini`
- **Messaging:** Sendblue API — inbound via webhook, outbound via send-message/send-group-message
- **Dashboard:** React + Vite + Tailwind (ops)
- **Build:** esbuild (CJS bundle)
- **API codegen:** Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`)

## Key Contracts

- **Organizer contract:** Proposals never reach the group without organizer approval via sidebar DM. The organizer's 1:1 thread is the only channel for reviewing/releasing group content.
- **Playbooks:** Trip, bachelorette, and reunion projects follow step-by-step playbooks defined in `lib/agent/playbooks.ts`. The timeline is instantiated from the playbook on project creation.
- **Ledger:** Costs are split per-head and tracked in `projectLedger`. The organizer records estimates via sidebar; payment-request DMs go to each member.
- **Scheduler / quiet hours (C2):** All proactive sends check `canSendProactiveMessage()` before sending. Messages outside 09:00–21:00 local time are deferred. No handler bypasses this gate.
- **Pending deliverables:** Async promises (JIT venue extraction, lodging search) are tracked in the `pending_deliverables` table. Results are delivered on completion or via backstop-fallback after a 5-minute SLA.

## Database / Migrations

- **Schema source of truth:** `lib/db/src/schema/`
- **Dev (idempotent push):** `pnpm --filter @workspace/db exec drizzle-kit push`
- **Schema changes:** edit schema → `drizzle-kit generate` → `drizzle-kit migrate`
- **Fresh provisioning (MVP):** `drizzle-kit push`
- **Never:** hand-write SQL (old `scripts/migrations/` is archived); never use `push` on production data

## Configuration

Central config: `artifacts/api-server/src/lib/config.ts` — Zod-validated at boot. All vars documented in `.env.example`.

| Category | Variables |
|---|---|
| Required at boot | `DATABASE_URL`, `SESSION_SECRET` |
| AI features | `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY` |
| Messaging | `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET` |
| Optional | `CONCIERGE_TIMEZONE`, `GOOGLE_PLACES_API_KEY`, `QUIET_HOURS_START`, `QUIET_HOURS_END`, `PUBLIC_API_URL` |

Without `SENDBLUE_*`: emulator/dev mode, sends are no-ops (logged, not thrown).

## Testing

```bash
pnpm --filter @workspace/api-server test                 # unit (no DB needed)
pnpm --filter @workspace/api-server test:all             # unit + integration
pnpm --filter @workspace/api-server test:scenarios       # scenarios (needs DATABASE_URL)
SCENARIO_RECORD=1 pnpm --filter @workspace/api-server test:scenarios  # refresh LLM replay cache
```

- Scenarios live in `src/testing/scenarios/*.scenario.ts`
- **Standing rule:** every dogfood bug gets a scenario before a fix

## Development

```bash
# API server (port 8080)
pnpm --filter @workspace/api-server run dev

# Ops dashboard
pnpm --filter @workspace/concierge-dashboard run dev

# Typecheck
pnpm --filter @workspace/api-server run typecheck

# Full workspace typecheck
pnpm run typecheck

# Regenerate API hooks + Zod schemas from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Venue corpus population
pnpm --filter @workspace/api-server run populate-venues -- --neighborhood "<name>" [--borough <name>] [--venue-type restaurant|bar] [--limit <n>]
```

## Where Things Live

- **DB schema:** `lib/db/src/schema/`
- **API contract:** `lib/api-spec/openapi.yaml` — run codegen after editing
- **Webhook / orchestration loop:** `artifacts/api-server/src/routes/webhooks/sendblue.ts`
- **Command registry:** `artifacts/api-server/src/lib/agent/commands/index.ts` — deterministic commands before LLM turn
- **LLM engine:** `artifacts/api-server/src/lib/agent/engine.ts`
- **Playbooks:** `artifacts/api-server/src/lib/agent/playbooks.ts`
- **Polls:** `artifacts/api-server/src/lib/agent/polls.ts`
- **Bookings:** `artifacts/api-server/src/lib/agent/bookings.ts`
- **Ledger:** `artifacts/api-server/src/lib/agent/ledger.ts`
- **Scheduler:** `artifacts/api-server/src/lib/agent/scheduler.ts`
- **Sendblue client:** `artifacts/api-server/src/lib/sendblue.ts`
- **Dashboard routes:** `artifacts/api-server/src/routes/{users,threads,bookings,venues,projects}.ts`
- **Venue corpus:** `artifacts/api-server/src/lib/agent/venueCorpus/`

## Gotchas

- Webhook endpoint: `POST /api/webhooks/sendblue/:secret` — the `:secret` segment must match `SENDBLUE_WEBHOOK_SECRET`. Register the full URL (including secret) in Sendblue; they don't sign payloads.
- Always run `pnpm --filter @workspace/api-spec run codegen` after editing the OpenAPI spec, then typecheck.
- `GOOGLE_PLACES_API_KEY` required for venue photo carousels and place-ID lookups. Without it, carousels are skipped.
- 1:1 threads keyed by `threads.primaryPhoneNumber`; group threads by `threads.sendblueGroupId`.
- Sendblue send failures are logged and swallowed — a failed send never crashes message processing.

## User Preferences

- Booking flow should always go through a human-approval step over text; do not call a real booking provider yet — that's an explicit later phase.
- Ops dashboard should be simple: view users, threads, and pending approvals (built as a separate task).
