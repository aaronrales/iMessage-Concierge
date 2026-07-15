---
name: Mark-before-send ordering for proactive/scheduled sends
description: Decision on which side of a send to put the "already handled" DB write, for at-most-once outbound messaging.
---

For scheduler jobs that send a proactive/one-time message and then persist a "done/sent/reminded" marker (feedback prompts, occasion reminders, onboarding nudges), write the marker **before** calling the send function, not after.

**Why:** a process crash or restart between the send and the persist previously risked a duplicate send on the next scan (send succeeded, marker never written, so the item gets picked up again). Reordering to mark-first means the failure mode flips to *at most a skipped send* (marker written, crash before send goes out) -- silently missing one proactive nudge is a much smaller problem than the concierge texting the same reminder twice.

**How to apply:** this ordering only makes sense once budget/eligibility gating has already passed -- gate first, then mark, then send. Applies anywhere a job both sends a message and flips a "don't send this again" flag. If the marker also changes how the *next inbound message* gets interpreted (e.g. "the thread is now awaiting a reply to this prompt"), wrap the send in its own try/catch and roll the marker back on a caught failure -- mark-before-send should only fail toward "silently skipped" for a hard crash, never toward misinterpreting the user's next message.
