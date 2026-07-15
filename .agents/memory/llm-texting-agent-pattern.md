---
name: LLM-driven texting agent pattern
description: How to structure an SMS/iMessage bot that mixes free-form LLM replies with deterministic state changes (votes, approvals).
---

Rule: keep anything auditable (vote tallies, approve/reject decisions) as deterministic code that runs *before* the LLM turn, and only fall through to the LLM for open-ended conversation.

**Why:** Letting the model both decide free-text replies and silently tally votes/approvals makes "did everyone vote" or "was this approved" unverifiable and prone to hallucinated state. A cheap regex/substring match for votes and yes/no approval intent is trivial to test and impossible for the model to get subtly wrong.

**How to apply:** In the inbound-message handler, check in order: (1) is there an open poll and does this message match an option label/number → record vote, tally deterministically, auto-announce winner when all participants voted; (2) is the sender a pending booking's designated approver and does the message match an approve/reject pattern → apply directly; (3) otherwise, run one LLM completion that returns a single structured JSON envelope (reply text + optional profile updates + optional new poll + optional booking draft) rather than chaining multiple LLM calls per message.
