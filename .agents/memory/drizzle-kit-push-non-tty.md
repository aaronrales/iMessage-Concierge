---
name: drizzle-kit push in a non-TTY shell
description: drizzle-kit push hangs/crashes when it needs to ask a destructive-change question (e.g. adding a unique constraint to a populated table) and stdin isn't a TTY.
---

`drizzle-kit push` interactively prompts ("Do you want to truncate table X?") whenever a schema change looks destructive -- notably adding a `unique()` constraint to a column on a table that already has rows. In this sandboxed shell, stdin/stdout aren't a TTY, so the prompt throws `Error: Interactive prompts require a TTY terminal` instead of waiting for input, and the migration never applies.

**How to apply:** before running `push`, check whether the change is actually safe (e.g. query for duplicate values on the column getting a new unique constraint). If it is safe, apply that one specific DDL statement directly via a raw `pg` client connected to `DATABASE_URL`, then re-run `drizzle-kit push` -- it will see the column/constraint already matches the schema and apply the rest (indexes, etc.) without hitting the interactive branch.
