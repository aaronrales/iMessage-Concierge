---
name: Free-text over pg-enum for extensible LLM-extracted vocab
description: When a field's set of valid values is expected to grow over time (new signal sources, attribute dimensions, venue/entity types), model it as a `text` column, not a pg-enum.
---

For fields whose vocabulary is expected to expand as the product grows (e.g. a venue corpus's signal sources, attribute dimensions, or venue types), use a plain `text` column instead of a Postgres enum type.

**Why:** a pg-enum requires an `ALTER TYPE ... ADD VALUE` migration (and in older Postgres, a transaction-boundary workaround) every time a new value is needed. If the product spec explicitly says the vocabulary should be extensible without a migration (e.g. adding a new attribute dimension or a new venue type like "event"/"activity" later), a pg-enum works against that goal.

**How to apply:** keep the *known* values as an application-level constant (e.g. an array/const object used for validation, iteration, and weighting), but let the underlying DB column be `text`. Validate against the constant at the application layer where it matters (e.g. reject unknown values on write), rather than relying on the DB type system to enforce the set.
