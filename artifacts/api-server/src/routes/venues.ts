import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  ApproveVenueParams,
  ApproveVenueResponse,
  DowngradeVenueParams,
  DowngradeVenueResponse,
  GetVenueParams,
  GetVenueResponse,
  ListVenuesQueryParams,
  ListVenuesResponse,
  RejectVenueParams,
  RejectVenueResponse,
} from "@workspace/api-zod";
import { z } from "zod";
import { approveVenueToTier1, downgradeVenueToTier2, getVenueReviewDetail, listVenuesByTier, rejectVenueToUntiered } from "../lib/agent/venueCorpus/review";
import { db, venuesTable } from "@workspace/db";

const router: IRouter = Router();

/** Ops review queue: lists venues by tier, defaulting to `pending_review` -- the queue reviewers act on day to day. */
router.get("/venues", async (req, res): Promise<void> => {
  const query = ListVenuesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const tier = query.data.tier ?? "pending_review";
  const rows = await listVenuesByTier(tier);
  res.json(ListVenuesResponse.parse(rows));
});

router.get("/venues/:id", async (req, res): Promise<void> => {
  const params = GetVenueParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const detail = await getVenueReviewDetail(params.data.id);
  if (!detail) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  res.json(GetVenueResponse.parse(detail));
});

router.patch("/venues/:id/approve", async (req, res): Promise<void> => {
  const params = ApproveVenueParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(venuesTable).where(eq(venuesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const venue = await approveVenueToTier1(params.data.id);
  res.json(ApproveVenueResponse.parse(venue));
});

router.patch("/venues/:id/downgrade", async (req, res): Promise<void> => {
  const params = DowngradeVenueParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(venuesTable).where(eq(venuesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const venue = await downgradeVenueToTier2(params.data.id);
  res.json(DowngradeVenueResponse.parse(venue));
});

router.patch("/venues/:id/reject", async (req, res): Promise<void> => {
  const params = RejectVenueParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(venuesTable).where(eq(venuesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const venue = await rejectVenueToUntiered(params.data.id);
  res.json(RejectVenueResponse.parse(venue));
});

/** Inline schema — not part of the public API-spec codegen; kept here to avoid extra spec paths. */
const UpdateVenueParamsSchema = z.object({ id: z.coerce.number().int() });
const UpdateVenueBodySchema = z.object({
  /** Google Places ID for photo carousel fetching. Pass null to clear. */
  googlePlaceId: z.string().nullable().optional(),
});

router.patch("/venues/:id", async (req, res): Promise<void> => {
  const params = UpdateVenueParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateVenueBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(venuesTable).where(eq(venuesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const [updated] = await db
    .update(venuesTable)
    .set({
      ...(body.data.googlePlaceId !== undefined ? { googlePlaceId: body.data.googlePlaceId } : {}),
    })
    .where(eq(venuesTable.id, params.data.id))
    .returning();

  res.json(updated);
});

export default router;
