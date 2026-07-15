# BRD: Curated Venue Corpus — NYC Launch (v2)

**Owner:** Aaron · **Status:** Draft v2 (decisions locked, ready to schedule) · **Repo:** iMessage-Concierge
**Supersedes:** `attached_assets/Pasted--BRD-Curated-Venue-Corpus-NYC-Launch-Owner-Aaron-Status_1784125297945.txt` (v1) — same objective, scope, and architecture; this version resolves the three open questions from v1 and adds an execution plan.

## Objective & Scope

Unchanged from v1: replace commodity place data with a proprietary, quality-validated corpus of NYC venues (restaurants and bars first, events as fast-follow), combining a cross-signal validation graph, an LLM-extracted attribute layer, and first-party outcome data that progressively takes over ranking. Target ~500 Tier 1 NYC venues at launch. See v1 for the full architecture (signal graph / attribute layer / first-party groundwork) and data model sketch — none of that changes here.

## Roadmap placement

This work is sequenced **after Phase 2** (Lovability & growth — merged) and **after Phase 3** (Group taste engine & serendipity — merged), both of which are already done. It's ready to be scheduled as the next phase whenever you want to start it — nothing else is blocking it.

## Resolved decisions (was: "Open Questions" in v1)

**1. Signal weighting** — Hand-tuned weights at launch (not fit against a labeled set). Revisit once there's enough recommendation-outcome data (the `recommendation_events`/`venue_feedback` tables from v1's Layer 3) to fit weights empirically instead of guessing.

**2. Editorial signal sourcing** — No scraping/APIs for Infatuation, Eater 38, Michelin, etc. Instead, an LLM pipeline web-searches each venue and extracts a best-effort signal per source (presence/absence, guide name, rough sentiment) directly into the signal graph. Tradeoffs, explicitly accepted: lower per-signal confidence than a scraped/structured source, but much faster to stand up and no per-source ToS/scraping engineering. This also **broadens the signal set beyond v1's original list** — Google ratings, Reddit mentions, and Resy/OpenTable bookability/signals are all in scope for the same web-search extraction approach, not just the editorial guides.

**3. Infatuation/Chase partnership exploration** — This refers to a *business development* idea floated in v1: potentially partnering with The Infatuation (a restaurant guide/media company) and/or Chase (which has an existing dining-perks/reservations tie-up with The Infatuation) for data access or co-marketing, rather than treating Infatuation purely as a web-searched signal. **Decision: not a dev task.** Tracked as a business-side note only — no engineering work, no project task, no schema dependency. If a partnership materializes later, it would change *how* the Infatuation signal is sourced, not the underlying schema.

## Population & pre-launch spot-check plan

You'll run the ~500-venue population and the pre-launch human spot-check pass yourself, with tooling built for it. Recommended approach:

- **Population script** (batch job, not a UI): given a target neighborhood/borough, pulls a venue candidate list (e.g. via the existing Yelp integration already used for `search_venues`), then for each candidate runs the LLM web-search extraction pass (signals + attributes from BRD Layer 1 & 2) and writes results into `venues`/`venue_signals`/`venue_attributes` at a `pending_review` tier — never directly into Tier 1. Designed to be re-run per-neighborhood so it doubles as the "repeatable city bring-up playbook" v1 asks for.
- **Spot-check review tool**: a lightweight page in the existing Concierge Ops Dashboard (`artifacts/concierge-dashboard`) — a queue of `pending_review` venues, each showing its extracted signals/attributes with confidence scores and source links, with **approve → Tier 1**, **downgrade → Tier 2**, or **reject → untiered** actions. This gives you a fast, low-friction way to do the human spot-check pass without touching SQL directly, and doubles as the ongoing tool for reviewing re-validation flags later (e.g. closure detection).
- **Sequencing within the phase**: schema + population script + LLM extraction pipeline first, then the review tool, then the actual 500-venue population/spot-check pass using both.

## What's unchanged from v1

Freshness/revalidation cadence, the data model sketch, and success criteria all carry over as-is from v1 — see that document for details.
