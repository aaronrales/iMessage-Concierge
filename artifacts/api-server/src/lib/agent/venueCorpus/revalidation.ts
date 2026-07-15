import { eq, lte, or, isNull, and } from "drizzle-orm";
import { db, venuesTable, venueTypeRevalidationConfigTable, type Venue } from "@workspace/db";
import { logger } from "../../logger";
import { extractVenueSignalsAndAttributes } from "./extraction";
import { recomputeVenueScore } from "./scoring";
import { upsertVenueSignalsAndAttributes } from "./writeExtraction";
import { DEFAULT_REVALIDATION_CADENCE_DAYS } from "./constants";

/** Seeds the per-venue-type cadence config on first startup; safe to call every boot (no-op if rows already exist). */
export async function ensureRevalidationConfigSeeded(): Promise<void> {
  for (const [venueType, cadenceDays] of Object.entries(DEFAULT_REVALIDATION_CADENCE_DAYS)) {
    await db
      .insert(venueTypeRevalidationConfigTable)
      .values({ venueType, cadenceDays })
      .onConflictDoNothing({ target: venueTypeRevalidationConfigTable.venueType });
  }
}

async function getCadenceDaysForType(venueType: string): Promise<number> {
  const [config] = await db
    .select()
    .from(venueTypeRevalidationConfigTable)
    .where(eq(venueTypeRevalidationConfigTable.venueType, venueType));
  return config?.cadenceDays ?? DEFAULT_REVALIDATION_CADENCE_DAYS[venueType] ?? 30;
}

/** Tiered/reviewed venues due for revalidation: never validated, or last validated longer ago than their type's cadence. */
export async function getVenuesDueForRevalidation(): Promise<Venue[]> {
  const candidates = await db
    .select()
    .from(venuesTable)
    .where(and(or(eq(venuesTable.tier, "tier1"), eq(venuesTable.tier, "tier2")), eq(venuesTable.closureSuspected, false)));

  const due: Venue[] = [];
  const now = Date.now();
  for (const venue of candidates) {
    const cadenceDays = await getCadenceDaysForType(venue.venueType);
    const cadenceMs = cadenceDays * 24 * 60 * 60 * 1000;
    const lastValidatedMs = venue.lastValidatedAt?.getTime() ?? 0;
    if (now - lastValidatedMs >= cadenceMs) {
      due.push(venue);
    }
  }
  return due;
}

/**
 * Re-pulls signals/attributes for one venue, recomputes score/tier
 * suggestion, and immediately suppresses (via `closureSuspected`) any venue
 * whose fresh search results indicate it has closed -- this suppression is
 * NOT gated on human review; a suspected-closed venue must stop being
 * recommendable the moment the signal is seen, review can restore it later
 * if it turns out to be a false positive.
 */
export async function revalidateVenue(venue: Venue): Promise<{ suppressed: boolean }> {
  const extraction = await extractVenueSignalsAndAttributes(venue.name, venue.neighborhood, venue.city);
  if (!extraction) {
    logger.warn({ venueId: venue.id, venueName: venue.name }, "Revalidation extraction pass failed; leaving venue as-is for the next scan");
    return { suppressed: venue.closureSuspected };
  }

  await upsertVenueSignalsAndAttributes(venue.id, extraction);

  await db
    .update(venuesTable)
    .set({ closureSuspected: extraction.closureSuspected })
    .where(eq(venuesTable.id, venue.id));

  await recomputeVenueScore(venue.id);

  if (extraction.closureSuspected) {
    logger.warn({ venueId: venue.id, venueName: venue.name, note: extraction.closureNote }, "Venue suppressed: closure suspected on revalidation");
  }

  return { suppressed: extraction.closureSuspected };
}

/** Monthly (per-cadence) revalidation scan across all tiered venues due for a re-check. */
export async function runRevalidationScan(): Promise<{ checked: number; suppressed: number }> {
  const due = await getVenuesDueForRevalidation();
  let suppressed = 0;
  for (const venue of due) {
    try {
      const result = await revalidateVenue(venue);
      if (result.suppressed) suppressed += 1;
    } catch (error) {
      logger.error({ error, venueId: venue.id }, "Revalidation failed for venue");
    }
  }
  return { checked: due.length, suppressed };
}
