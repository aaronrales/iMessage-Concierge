# iMessage Concierge

A personal AI concierge that lives inside iMessage. It joins 1:1 and group threads, gets to know each person through a short conversational onboarding, helps plan everyday activities (dinners, trips, meetups), runs group polls to reach consensus, and drafts bookings that always require human approval before being considered confirmed.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secrets for real iMessage traffic (not yet set — see Gotchas): `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_FROM_NUMBER`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- LLM: OpenAI via the Replit AI Integrations proxy (`AI_INTEGRATIONS_OPENAI_*` env vars), model `gpt-5.4-mini`
- iMessage transport: Sendblue API (`https://api.sendblue.com`), inbound via webhook, outbound via `/api/send-message` and `/api/send-group-message`

## Where things live

- DB schema: `lib/db/src/schema/` — `users`, `profiles`, `threads`, `threadParticipants`, `messages`, `polls`/`pollOptions`/`pollVotes`, `bookings`
- API contract: `lib/api-spec/openapi.yaml` — source of truth; run codegen after editing
- Sendblue webhook receiver: `artifacts/api-server/src/routes/webhooks/sendblue.ts` — this is the core orchestration loop (vote detection → approval detection → LLM turn)
- Sendblue outbound client: `artifacts/api-server/src/lib/sendblue.ts`
- LLM conversation engine: `artifacts/api-server/src/lib/agent/engine.ts` — single structured-JSON completion per inbound message (reply + profile updates + onboarding + poll + booking draft)
- Poll tallying: `artifacts/api-server/src/lib/agent/polls.ts`
- Booking draft/approval helpers: `artifacts/api-server/src/lib/agent/bookings.ts`
- Dashboard read/action API routes: `artifacts/api-server/src/routes/{users,threads,bookings}.ts`

## Architecture decisions

- **One LLM call per inbound message, structured JSON output.** The model returns `{ reply, display_name, profile_updates, onboarding_complete, poll, booking_draft }` in a single completion rather than separate classifier + responder calls, to keep latency and cost low for a texting UX.
- **Poll voting and booking approval are deterministic, not LLM-mediated.** Vote matching (`matchOption`) and approve/reject intent (`detectApprovalIntent`) use simple text matching before falling through to the LLM turn. This keeps the "did everyone vote / was this approved" logic auditable and avoids the model silently mis-tallying.
- **Booking approval is always required before a booking is considered real.** `bookings.status` moves `drafted → pending_approval → approved/rejected/confirmed`. No real booking-provider API is called yet — `confirmBooking` simulates success. `provider`/`providerBookingId` columns exist for a future real integration.
- **Default approver is the message sender** when the LLM doesn't specify one, so the flow always works even in a 1:1 thread or when the group doesn't name an approver.
- **1:1 threads are keyed by phone number** (`threads.primaryPhoneNumber`), group threads by Sendblue's `group_id` (`threads.sendblueGroupId`) — there's no other stable group identifier from Sendblue.
- Sendblue outbound send failures are logged and swallowed, not thrown — a failed send should never crash message processing or lose the DB record of what happened.

## Product

- Texts an unknown number → the concierge creates a user + 1:1 thread, greets them, and asks 1-2 light onboarding questions (name, a preference) instead of a form.
- Learns and stores per-person budget, dietary needs, free-text preferences, and notes as they come up naturally in conversation.
- In a group thread, can start a poll with options; tallies votes as people reply and auto-announces the winner once everyone's voted.
- Can draft a booking from a decided plan; sends the designated approver a yes/no request over text (or asks the same person if no approver is specified) and only marks it confirmed after they approve.
- Read/action HTTP API exists for an ops dashboard (Task #2, pending): list users+profiles, list/inspect threads with messages and poll tallies, list bookings (filterable by status), and approve/reject a pending booking directly.

## User preferences

- Booking flow should always go through a human-approval step over text; do not call a real booking provider yet — that's an explicit later phase.
- Ops dashboard should be simple: view users, threads, and pending approvals (built as a separate task).

## Gotchas

- `SENDBLUE_API_KEY_ID` / `SENDBLUE_API_SECRET_KEY` / `SENDBLUE_FROM_NUMBER` must be set (via secrets) for real outbound iMessage sends to work. The webhook receiver and dashboard APIs work fully without them (verified via direct webhook POSTs); `sendblue.ts` logs a warning and no-ops on send rather than throwing when they're missing.
- The webhook endpoint is `POST /api/webhooks/sendblue/:secret` — the `:secret` path segment must match the `SENDBLUE_WEBHOOK_SECRET` env var (auto-generated, not a Sendblue-issued value). This is the only authenticity check available since Sendblue doesn't sign webhook payloads. Register this exact full URL (including the secret) as the Sendblue `receive` webhook, not the bare `/api/webhooks/sendblue` path.
- Always run `pnpm --filter @workspace/api-spec run codegen` after editing `lib/api-spec/openapi.yaml`, then `pnpm --filter @workspace/api-server run typecheck`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
