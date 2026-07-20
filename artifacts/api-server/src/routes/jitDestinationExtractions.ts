import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, destinationVenueExtractionsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { isNYCDestination } from "../lib/agent/venueCorpus/jitExtraction";
import { enqueueJITExtractionIfNeeded } from "../lib/agent/scheduler";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** GET /jit-destination-extractions — list all JIT extractions (for the dashboard) */
router.get("/jit-destination-extractions", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(destinationVenueExtractionsTable)
    .orderBy(desc(destinationVenueExtractionsTable.createdAt))
    .limit(100);

  res.json(rows);
});

const TriggerBodySchema = z.object({
  destination: z.string().min(1),
});

/** POST /jit-destination-extractions — manually trigger extraction for a destination */
router.post("/jit-destination-extractions", async (req, res): Promise<void> => {
  const body = TriggerBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { destination } = body.data;

  if (isNYCDestination(destination)) {
    res.status(400).json({ error: "NYC destinations use the curated corpus — JIT extraction is not needed." });
    return;
  }

  try {
    await enqueueJITExtractionIfNeeded(destination);
    res.status(202).json({ queued: true, destination });
  } catch (error) {
    logger.error({ error, destination }, "Failed to enqueue JIT extraction");
    res.status(500).json({ error: "Failed to enqueue extraction" });
  }
});

export default router;
