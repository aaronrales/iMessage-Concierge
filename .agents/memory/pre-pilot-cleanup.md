---
name: Pre-pilot cleanup wave
description: What was built in the B/C/D/E cleanup waves and where to find each piece
---

## B1 — Project closeout lifecycle
- Schema: `closeoutPromptSentAt`, `closedAt` on `projectsTable`
- Scheduler: `handleProjectCloseoutScan` — queues at 1pm daily; prompts organizer DM at +1d, re-nudges at +3d, auto-closes at +7d
- Webhook: `/\bclose\s+it\s+out\b/i` regex in organizer sidebar block (before agent turn) → sets `status="done"` + sends group wrap-up

## B2 — Tiebreak defers to organizer
- `handlePollTiebreakAnnounce`: if active project + organizer → DM organizer, 24h window; else keep existing group/1h behavior
- `handlePollTiebreakLock`: uses neutral phrasing ("Locking in X…") when project exists

## B3 — Occasions ↔ projects
- Schema: `projectId` on `occasionsTable`
- `handleOccasionScan`: skips if occasion.projectId set OR active project's honoreeUserId matches
- Acceptance handler: TODO comment in sendblue.ts near captureOccasion

## C1 — LLM cost logging
- New table: `llm_cost_log` (module, model, prompt/completion tokens, estimated cents)
- Files: `lib/agent/costRates.ts`, `lib/agent/costLogger.ts`
- `logLlmCost()` fire-and-forget after every LLM call in: engine, etiquette, onboarding, groupIntro, privateInput, destinationSuggestions, jitExtraction
- Dashboard: "LLM Cost (7d)" card on Operations page; API: GET /api/cost-summary

## C2 — Quiet hours
- `canSendProactiveMessage` now returns `ProactiveMessageCheck` union (`{ allowed: true }` | `{ allowed: false; reason; nextAllowedAt? }`)
- Quiet window: QUIET_HOURS_START (default 21) → QUIET_HOURS_END (default 9) in CONCIERGE_TIMEZONE
- All scheduler call sites updated; quiet-hours deferrals log at info level

## D1/D2/D3 — Scenario runner + testing
- Vitest split: `unit` (src/tests/**) and `integration` (*.integration.test.ts + *.scenario.ts)
- Scripts: `test` (unit only), `test:all`, `test:scenarios`
- `src/lib/agent/runEmulatorTurn.ts` — shared entry point for emulator route + scenario runner
- `src/testing/scenarioRunner.ts` — `scenario()` builder (describe + it blocks, clock control)
- `src/testing/seed.ts` — seedUser/seedDirectThread/seedGroupThread/cleanupSeededData
- `src/testing/llmCache.ts` — SCENARIO_RECORD=1 record/replay cache
- 7 scenarios in `src/testing/scenarios/`: lake-como-trip, bachelorette-happy-path, organizer-tiebreak (skeleton), project-closeout (skeleton), etiquette-silence, privacy-scrub, occasion-to-project (skeleton)

## D5 — Emulator UX
- Emulator.tsx: "Send as" persona switcher (uses thread participants), scenario reference panel, "Export as scenario draft" download button

## E3/E5/E6
- replit.md: fully refreshed with contracts, testing, config, migration policy
- sendblue.ts: architecture note comment + TODO migration marker
- `src/lib/agent/commands/index.ts`: Command registry scaffold

**Why:** Documented here because the scope was large; future sessions should not redo any of these and can trust they exist.
**How to apply:** When touching the scheduler, budget, webhook, or emulator, verify these pieces are intact before extending.
