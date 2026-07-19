---
name: One-active-row invariants under concurrent turns
description: How "at most one active X per thread" is enforced (partial unique index + conflict-fallback merge) and the plan re-parenting rules around projects.
---

# One-active-row invariants under concurrent webhook turns

Webhook turns for the same thread can overlap (debounce does not serialize
in-flight turns), so read-then-insert "get or create" helpers race.

**Rule:** enforce "at most one active row per thread" with a Postgres partial
unique index (`... ON <table> (thread_id) WHERE status IN (<active statuses>)`),
and in the create helper catch error code `23505`, re-read the winner, and
merge into it instead of failing the turn.

**Why:** the projects layer originally used read-then-insert only; a review
pass flagged that two concurrent turns could both create "active" projects,
making plan parentage nondeterministic. App-level checks cannot close this
race; only a DB constraint can.

**How to apply:** any future "one active per thread/user" entity (occasion
locks, playbook runs, etc.) should get the same partial-index + 23505-fallback
pattern. Note the index predicate hardcodes the active status list — statuses
are code-controlled lifecycle values (fine to enumerate), unlike open-vocab
`type` columns which stay free text.

## Related: plan adoption rules (projects layer)

- When a project is created, at most ONE standalone plan is adopted as its
  first child, and only if still forming (`proposed`/`deciding`).
- **Never re-parent a `confirmed` plan** into a newly created project — a
  locked-in unrelated event must not be silently re-labeled as part of a new
  occasion. Prefer creating a fresh child plan and leaving the confirmed
  standalone alone (one confirmed standalone coexisting with project children
  is acceptable).
- LLM-extracted text that later re-enters system prompts (project type,
  honoree) must be sanitized at parse time: bounded slug for vocab fields,
  control-char stripping + length cap for names.
