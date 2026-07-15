# iMessage Concierge

A personal AI concierge that lives inside iMessage. It joins 1:1 and group threads, gets to know each person through a short conversational onboarding, helps plan everyday activities (dinners, trips, meetups), runs group polls to reach consensus, and drafts bookings that always require human approval before being considered confirmed.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/api-server run test` — run unit tests (Vitest)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secrets for real iMessage traffic (not yet set — see Gotchas): `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, `SENDBLUE_FROM_NUMBER`
- Optional: `PUBLIC_API_URL` — full base URL of this API server (e.g. `https://abc.replit.app/api-server`); enables `.ics` calendar links in confirmation texts
- Optional: `CONCIERGE_TIMEZONE` — IANA timezone for date formatting and cron schedules (defaults to `America/New_York`)

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

- DB schema: `lib/db/src/schema/` — `users`, `profiles`, `threads`, `threadParticipants`, `messages`, `polls`/`pollOptions`/`pollVotes`, `bookings`, `venues`/`venueSignals`/`venueAttributes`/`venueTypeRevalidationConfig`/`recommendationEvents`/`venueFeedback`
- API contract: `lib/api-spec/openapi.yaml` — source of truth; run codegen after editing
- Sendblue webhook receiver: `artifacts/api-server/src/routes/webhooks/sendblue.ts` — this is the core orchestration loop (vote detection → approval detection → LLM turn)
- Sendblue outbound client: `artifacts/api-server/src/lib/sendblue.ts`
- LLM conversation engine: `artifacts/api-server/src/lib/agent/engine.ts` — multi-iteration tool-calling loop; calls `search_venues` tool (Google Places) before returning a final structured-JSON reply (reply + profile updates + onboarding + poll + booking draft + occasion + private_question + home_city)
- Poll tallying: `artifacts/api-server/src/lib/agent/polls.ts`
- Booking draft/approval helpers: `artifacts/api-server/src/lib/agent/bookings.ts`
- Dashboard read/action API routes: `artifacts/api-server/src/routes/{users,threads,bookings,venues}.ts`
- Curated venue corpus (NYC): `artifacts/api-server/src/lib/agent/venueCorpus/` — extraction, scoring/tiering, review, lookup, population, revalidation, recommendation/feedback logging. Manual population runner: `pnpm --filter @workspace/api-server run populate-venues -- --neighborhood "<name>" [--borough <name>] [--venue-type restaurant|bar] [--limit <n>]`. Dashboard review queue at `/venues`.

## Architecture decisions

- **Tool-calling loop, structured JSON output.** The agent runs in a loop (up to 3 iterations) calling `openai.chat.completions.create` with `tools: AGENT_TOOLS`. The model may call the `search_venues` tool (Google Places Text Search, `places.googleapis.com/v1/places:searchText`) zero or more times before returning a final structured-JSON reply `{ reply, display_name, profile_updates, onboarding_complete, home_city, poll, booking_draft, occasion, private_question }`. The fast 1:1 chitchat path resolves in one iteration (no tool call needed); venue suggestions trigger one extra round-trip. See `engine.ts` → `runTurnWithTools`.
- **Group etiquette gate with LLM fallback.** For group threads, the webhook checks `shouldRespondInGroup` (regex) first. If the regex says no and there is no active plan, a cheap single-completion LLM check (`checkPlanningIntentWithLLM`) catches short-form triggers like "drinks?" that the regex misses. If the regex says yes, or there is an active plan, the LLM check is skipped entirely to keep per-message cost near zero.
- **Group constraint boosting in corpus lookup.** When an agent turn runs in a group thread, `extractGroupConstraints` parses dietary needs, budget tiers, preferences, and party size from all members' profiles into a `GroupConstraints` struct. This is threaded through `executeAgentTool` → `lookupCorpusVenues`, which applies a ±15-point composite-score boost based on keyword matching against `venueAttributesTable` rows before final sort. The LLM also receives a text summary of constraints in its system prompt.
- **Poll voting and booking approval are deterministic, not LLM-mediated.** Vote matching (`matchOption`) and approve/reject intent (`detectApprovalIntent`) use simple text matching before falling through to the LLM turn. This keeps the "did everyone vote / was this approved" logic auditable and avoids the model silently mis-tallying.
- **Booking approval is always required before a booking is considered real.** `bookings.status` moves `drafted → pending_approval → approved/rejected/confirmed`. No real booking-provider API is called yet — `confirmBooking` simulates success. `provider`/`providerBookingId` columns exist for a future real integration.
- **Calendar delivery on plan confirmation.** When a booking is approved, the confirmation text includes a `.ics` calendar file link (served by `GET /api/plans/:id/calendar.ics`) when `PUBLIC_API_URL` is set, falling back to a Google Calendar URL. The `.ics` file opens directly in Apple Calendar on iPhone without requiring a Google account.
- **Default approver is the message sender** when the LLM doesn't specify one, so the flow always works even in a 1:1 thread or when the group doesn't name an approver.
- **1:1 threads are keyed by phone number** (`threads.primaryPhoneNumber`), group threads by Sendblue's `group_id` (`threads.sendblueGroupId`) — there's no other stable group identifier from Sendblue.
- **Timezone:** all date formatting and cron schedules use `CONCIERGE_TIMEZONE` (default: `America/New_York`). `describePlanSchedule` uses `Intl` with the explicit timezone; `pg-boss` schedules pass `{ tz: CONCIERGE_TIMEZONE }` so cron times are local, not UTC.
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
- `YELP_API_KEY` is not currently set. The venue candidate-sourcing step (`listVenueCandidates`, used by both the existing `search_venues` agent tool and the new venue-corpus population job) warns and returns zero candidates without it — set this secret before running the real NYC population pass.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
