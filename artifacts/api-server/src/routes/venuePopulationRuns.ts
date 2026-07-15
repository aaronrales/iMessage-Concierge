import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, venuePopulationRunsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { populateNeighborhood } from "../lib/agent/venueCorpus/population";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CreateRunBodySchema = z.object({
  neighborhood: z.string().min(1),
  borough: z.string().optional(),
  city: z.string().optional(),
  venueType: z.enum(["restaurant", "bar"]).default("restaurant"),
  customQuery: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(20),
});

/** POST /venue-population-runs — start a background population run */
router.post("/venue-population-runs", async (req, res): Promise<void> => {
  const body = CreateRunBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  // Pre-check for UX (avoids wasting a DB round-trip in the common case),
  // but the DB partial unique index is the authoritative gate — concurrent
  // requests that both pass this check will race to insert and one will get
  // a 23505 unique-violation, which we map to 409 below.
  const [existing] = await db
    .select({ id: venuePopulationRunsTable.id })
    .from(venuePopulationRunsTable)
    .where(eq(venuePopulationRunsTable.status, "running"))
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "A run is already in progress" });
    return;
  }

  let run: typeof venuePopulationRunsTable.$inferSelect;
  try {
    const [inserted] = await db
      .insert(venuePopulationRunsTable)
      .values({
        neighborhood: body.data.neighborhood,
        borough: body.data.borough ?? null,
        city: body.data.city ?? null,
        venueType: body.data.venueType,
        customQuery: body.data.customQuery ?? null,
        limit: body.data.limit,
        status: "running",
        startedAt: new Date(),
      })
      .returning();

    if (!inserted) {
      res.status(500).json({ error: "Failed to create run record" });
      return;
    }
    run = inserted;
  } catch (err: unknown) {
    // PostgreSQL unique-violation (23505) means the partial index caught a race.
    const pg = err as { code?: string };
    if (pg?.code === "23505") {
      res.status(409).json({ error: "A run is already in progress" });
      return;
    }
    throw err;
  }

  // Fire and forget — update the run row on completion/failure
  populateNeighborhood({
    neighborhood: body.data.neighborhood,
    borough: body.data.borough,
    city: body.data.city,
    venueType: body.data.venueType,
    query: body.data.customQuery,
    limit: body.data.limit,
  })
    .then(async (result) => {
      await db
        .update(venuePopulationRunsTable)
        .set({
          status: "completed",
          candidatesFound: result.candidatesFound,
          venuesWritten: result.venuesWritten,
          venuesSkipped: result.venuesSkipped,
          errors: result.errors,
          completedAt: new Date(),
        })
        .where(eq(venuePopulationRunsTable.id, run.id));
      logger.info({ runId: run.id, result }, "Venue population run completed");
    })
    .catch(async (error) => {
      await db
        .update(venuePopulationRunsTable)
        .set({
          status: "failed",
          errors: [{ venueName: "(run)", error: error instanceof Error ? error.message : String(error) }],
          completedAt: new Date(),
        })
        .where(eq(venuePopulationRunsTable.id, run.id));
      logger.error({ runId: run.id, error }, "Venue population run failed");
    });

  res.status(201).json(run);
});

/** GET /venue-population-runs — list the 50 most recent runs */
router.get("/venue-population-runs", async (_req, res): Promise<void> => {
  const runs = await db
    .select()
    .from(venuePopulationRunsTable)
    .orderBy(desc(venuePopulationRunsTable.createdAt))
    .limit(50);

  res.json(runs);
});

export default router;
