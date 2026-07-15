---
name: Monorepo TS project-reference staleness after schema/package changes
description: Why tsc can report phantom "property does not exist" errors for @workspace/db (or other lib/* packages) right after adding fields, and how to fix it.
---

`lib/db` (and similar `lib/*` packages) build with `composite: true` + `emitDeclarationOnly`, and other packages reference it via TS project references. The package's `package.json` `exports` field points at `./src/index.ts` (source), but consuming packages' type-checking actually resolves through the referenced project's compiled `dist/*.d.ts` files, not live source.

**Why:** after adding/editing a schema field or export in `lib/db/src`, `dist/*.d.ts` is stale until rebuilt. `tsc --noEmit` in a consuming package (e.g. `api-server`) then reports the new field/export as nonexistent even though the source is correct — this looks like a real type error but isn't.

**How to apply:** after any `lib/db` (or other composite `lib/*`) schema/export change, before trusting `tsc --noEmit` errors in dependents, run `npx tsc -b tsconfig.json` inside that lib package to regenerate `dist/*.d.ts`. Deleting stale `tsconfig.tsbuildinfo` files alone is not sufficient — the `dist/*.d.ts` themselves must be regenerated.
