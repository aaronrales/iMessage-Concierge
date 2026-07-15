---
name: LLM-driven texting agent pattern
description: How to structure an SMS/iMessage bot that mixes free-form LLM replies with deterministic state changes (votes, approvals).
---

Rule: keep anything auditable (vote tallies, approve/reject decisions) as deterministic code that runs *before* the LLM turn, and only fall through to the LLM for open-ended conversation.

**Why:** Letting the model both decide free-text replies and silently tally votes/approvals makes "did everyone vote" or "was this approved" unverifiable and prone to hallucinated state. A cheap regex/substring match for votes and yes/no approval intent is trivial to test and impossible for the model to get subtly wrong.

**How to apply:** In the inbound-message handler, check in order: (1) is there an open poll and does this message match an option label/number → record vote, tally deterministically, auto-announce winner when all participants voted; (2) is the sender a pending booking's designated approver and does the message match an approve/reject pattern → apply directly; (3) is the sender a 1:1 thread with an open "private input" request pending (a sensitive question the group asked to be collected via DM) → record the answer deterministically, never echo it into the group; (4) otherwise, run one LLM completion that returns a single structured JSON envelope (reply text + optional profile updates + optional new poll + optional booking draft) rather than chaining multiple LLM calls per message.

**Group etiquette gotcha:** if the group handler only replies when a message is "addressed to the bot" or matches planning-intent keywords, a message with real intent but no keyword match (e.g. "just pick something for us, surprise us") gets silently dropped even mid-conversation. This is by design (avoids replying to every message in a busy group) but looks like a bug when testing — check the etiquette gate before assuming a broken agent turn.

**Constraint satisfaction without disclosure:** when a group suggestion must silently satisfy every member's private constraints (budget, dietary needs) without naming whose constraint drove what, build an anonymized aggregate summary (union of values across members, no names attached) and inject it into the system/situational prompt with an explicit "never attribute" instruction. Keep the existing regex-based output scrub as a second line of defense — the aggregate summary reduces the chance of a leak, it doesn't guarantee one won't happen.
