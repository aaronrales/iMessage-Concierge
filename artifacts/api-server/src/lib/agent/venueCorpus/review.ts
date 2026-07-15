import { eq } from "drizzle-orm";
import { db, venueAttributesTable, venueSignalsTable, venuesTable, type Venue } from "@workspace/db";

/** Everything a review-queue row needs: the venue plus its signals/attributes with confidence and sources. */
export interface VenueReviewDetail {
  venue: Venue;
  signals: (typeof venueSignalsTable.$inferSelect)[];
  attributes: (typeof venueAttributesTable.$inferSelect)[];
}

export async function listVenuesByTier(tier: Venue["tier"]): Promise<Venue[]> {
  return db.select().from(venuesTable).where(eq(venuesTable.tier, tier)).orderBy(venuesTable.createdAt);
}

export async function getVenueReviewDetail(venueId: number): Promise<VenueReviewDetail | null> {
  const [venue] = await db.select().from(venuesTable).where(eq(venuesTable.id, venueId));
  if (!venue) return null;

  const signals = await db.select().from(venueSignalsTable).where(eq(venueSignalsTable.venueId, venueId));
  const attributes = await db.select().from(venueAttributesTable).where(eq(venueAttributesTable.venueId, venueId));

  return { venue, signals, attributes };
}

/** Reviewer action: approve a `pending_review` (or any) venue to Tier 1. */
export async function approveVenueToTier1(venueId: number): Promise<Venue> {
  return setVenueTier(venueId, "tier1");
}

/** Reviewer action: downgrade to Tier 2 (still recommendable, but hedged). */
export async function downgradeVenueToTier2(venueId: number): Promise<Venue> {
  return setVenueTier(venueId, "tier2");
}

/** Reviewer action: reject to untiered (never recommended). */
export async function rejectVenueToUntiered(venueId: number): Promise<Venue> {
  return setVenueTier(venueId, "untiered");
}

async function setVenueTier(venueId: number, tier: Venue["tier"]): Promise<Venue> {
  const [venue] = await db.update(venuesTable).set({ tier }).where(eq(venuesTable.id, venueId)).returning();
  if (!venue) throw new Error(`Venue ${venueId} not found`);
  return venue;
}
