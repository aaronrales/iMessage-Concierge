---
name: Monorepo TS staleness
description: Why dependents can show phantom type errors for symbols that already exist in generated/source packages.
---

Two known causes of "this export doesn't exist" errors in a dependent package even though the source already defines it:

1. After editing `lib/db` schema, rebuild its `dist/*.d.ts` (`tsc -b`) or dependents' typecheck shows phantom missing-property errors.
2. After running orval codegen (`pnpm --filter @workspace/api-spec run codegen`) against `lib/api-spec/openapi.yaml`, the regenerated `src/generated/*` in `lib/api-zod` / `lib/api-client-react` can be correct while their compiled `dist/*.d.ts` is stale/missing the new exports, since project-referenced packages type-check against `dist`, not `src`. Always run `pnpm -w run typecheck:libs` (which does `tsc --build`) after codegen, not just a diff of `src/generated`.

**Why:** TS project references resolve cross-package imports through each dependency's compiled `dist` output, not its `src`. Editing/regenerating `src` alone leaves consumers looking at old `dist` typings.

**How to apply:** Whenever a route/page file imports symbols that "don't exist" from `@workspace/api-zod` or `@workspace/api-client-react` (or any internal `lib/*` package), first check whether the OpenAPI spec / source already defines them before assuming the spec is missing pieces — it may just need `pnpm -w run typecheck:libs` (or a full `tsc -b`) to refresh `dist`.
