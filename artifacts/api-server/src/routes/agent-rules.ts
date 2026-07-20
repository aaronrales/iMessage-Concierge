import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { z } from "zod/v4";
import { db, agentRulesTable } from "@workspace/db";
import { invalidateRulesCache } from "../lib/agent/engine";

const router: IRouter = Router();

/** Returns true when the DB error is a unique-constraint violation (PG code 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

const VALID_CATEGORIES = ["behavior", "project", "tool"] as const;

const CreateRuleBody = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(VALID_CATEGORIES),
  content: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
});

const UpdateRuleBody = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.enum(VALID_CATEGORIES).optional(),
  content: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/** GET /agent-rules — list all rules ordered by sort_order */
router.get("/agent-rules", async (_req, res): Promise<void> => {
  const rules = await db
    .select()
    .from(agentRulesTable)
    .orderBy(asc(agentRulesTable.sortOrder), asc(agentRulesTable.id));
  res.json(rules);
});

/** POST /agent-rules — create a user-owned rule (is_built_in = false) */
router.post("/agent-rules", async (req, res): Promise<void> => {
  const body = CreateRuleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  try {
    const [rule] = await db
      .insert(agentRulesTable)
      .values({
        name: body.data.name,
        category: body.data.category,
        content: body.data.content,
        enabled: body.data.enabled,
        sortOrder: body.data.sortOrder,
        isBuiltIn: false,
      })
      .returning();

    res.status(201).json(rule);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `A rule named "${body.data.name}" already exists.` });
      return;
    }
    throw err;
  }
});

/** PUT /agent-rules/:id — update any rule (name, content, enabled, sortOrder; category blocked for built-in) */
router.put("/agent-rules/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const body = UpdateRuleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(agentRulesTable)
    .where(eq(agentRulesTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  // Category is locked for built-in rules to preserve semantic grouping
  const update: Partial<typeof agentRulesTable.$inferInsert> = {};
  if (body.data.name !== undefined) update.name = body.data.name;
  if (body.data.content !== undefined) update.content = body.data.content;
  if (body.data.enabled !== undefined) update.enabled = body.data.enabled;
  if (body.data.sortOrder !== undefined) update.sortOrder = body.data.sortOrder;
  if (body.data.category !== undefined && !existing.isBuiltIn) {
    update.category = body.data.category;
  }

  try {
    const [updated] = await db
      .update(agentRulesTable)
      .set(update)
      .where(eq(agentRulesTable.id, id))
      .returning();

    invalidateRulesCache();
    res.json(updated);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `A rule with that name already exists.` });
      return;
    }
    throw err;
  }
});

/** DELETE /agent-rules/:id — delete user-owned rules; 403 for built-in */
router.delete("/agent-rules/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(agentRulesTable)
    .where(eq(agentRulesTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  if (existing.isBuiltIn) {
    res.status(403).json({ error: "Built-in rules cannot be deleted. Disable them instead." });
    return;
  }

  await db.delete(agentRulesTable).where(eq(agentRulesTable.id, id));
  invalidateRulesCache();
  res.json({ ok: true });
});

export default router;
