import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, agentConfigTable } from "@workspace/db";

/**
 * Admin-controlled agent configuration.
 *
 * GET /agent-config         — returns all config keys (currently just globalGuidance).
 * PUT /agent-config         — upserts key/value pairs.
 *
 * The `globalGuidance` key is prepended to every agent system prompt when
 * non-empty, giving ops a real-time lever for cross-cutting corrections like
 * "always confirm dietary restrictions before suggesting a booking".
 */

const router: IRouter = Router();

const PutAgentConfigBody = z.object({
  globalGuidance: z.string().optional(),
});

router.get("/agent-config", async (_req, res): Promise<void> => {
  const rows = await db.select().from(agentConfigTable);
  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  res.json({ globalGuidance: config["globalGuidance"] ?? "" });
});

router.put("/agent-config", async (req, res): Promise<void> => {
  const body = PutAgentConfigBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  if (body.data.globalGuidance !== undefined) {
    await db
      .insert(agentConfigTable)
      .values({ key: "globalGuidance", value: body.data.globalGuidance })
      .onConflictDoUpdate({
        target: agentConfigTable.key,
        set: { value: body.data.globalGuidance, updatedAt: new Date() },
      });
  }

  res.json({ ok: true });
});

export default router;
