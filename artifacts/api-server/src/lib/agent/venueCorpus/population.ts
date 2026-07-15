import { eq, and } from "drizzle-orm";
import { db, venuesTable } from "@workspace/db";
import { logger } from "../../logger";
import { listVenueCandidates } from "../tools";
import { extractVenueSignalsAndAttributes } from "./extraction";
import { recomputeVenueScore } from "./scoring";
import { upsertVenueSignalsAndAttributes } from "./writeExtraction";
import { DEFAULT_CITY } from "../weather";

/**
 * Population batch job -- "city bring-up playbook". Given a target
 * neighborhood/borough, pulls a venue candidate list (via the existing Yelp
 * integration) and runs the LLM web-search extraction pass across all
 * candidates, writing everything at `pending_review` tier. Designed to be
 * re-run per-neighborhood; running it twice for the same neighborhood
 * re-extracts and refreshes existing rows rather than duplicating them.
 *
 * This module intentionally does NOT run the actual ~500-venue population
 * pass -- that's a manual, product-owner-driven step using this tooling
 * (see `artifacts/api-server/src/scripts/populateVenues.ts`).
 */

export interface PopulateNeighborhoodOptions {
  neighborhood: string;
  borough?: string;
  city?: string;
  venueType?: "restaurant" | "bar";
  /** Yelp search term, defaults to a broad restaurants/bars query. */
  query?: string;
  limit?: number;
}

export interface PopulateNeighborhoodResult {
  candidatesFound: number;
  venuesWritten: number;
  venuesSkipped: number;
  errors: { venueName: string; error: string }[];
}

async function upsertCandidateAsVenue(
  candidateName: string,
  candidateAddress: string | undefined,
  candidateCategory: string,
  candidateSourceRef: string,
  options: PopulateNeighborhoodOptions,
) {
  const [existing] = await db
    .select()
    .from(venuesTable)
    .where(and(eq(venuesTable.name, candidateName), eq(venuesTable.neighborhood, options.neighborhood)));

  if (existing) {
    // Re-running a neighborhood re-extracts against the existing row rather than duplicating it.
    return existing;
  }

  const [created] = await db
    .insert(venuesTable)
    .values({
      name: candidateName,
      venueType: options.venueType ?? "restaurant",
      neighborhood: options.neighborhood,
      borough: options.borough ?? null,
      city: options.city ?? DEFAULT_CITY,
      address: candidateAddress ?? null,
      category: candidateCategory,
      tier: "pending_review",
      candidateSourceRef,
    })
    .returning();
  if (!created) throw new Error(`Failed to insert venue candidate ${candidateName}`);
  return created;
}

/** Runs the full population pipeline for a single neighborhood/borough. */
export async function populateNeighborhood(options: PopulateNeighborhoodOptions): Promise<PopulateNeighborhoodResult> {
  const city = options.city ?? DEFAULT_CITY;
  const searchLocation = options.borough ? `${options.neighborhood}, ${options.borough}, ${city}` : `${options.neighborhood}, ${city}`;
  const query = options.query ?? (options.venueType === "bar" ? "bars" : "restaurants");

  const candidates = await listVenueCandidates(query, searchLocation, options.limit ?? 20);
  const result: PopulateNeighborhoodResult = {
    candidatesFound: candidates.length,
    venuesWritten: 0,
    venuesSkipped: 0,
    errors: [],
  };

  for (const candidate of candidates) {
    try {
      const venue = await extractAndWriteVenue(candidate.name, candidate.address, candidate.category, candidate.sourceRef, options);
      if (venue) {
        result.venuesWritten += 1;
      } else {
        result.venuesSkipped += 1;
      }
    } catch (error) {
      logger.error({ error, candidate }, "Failed to populate venue candidate");
      result.errors.push({ venueName: candidate.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}

/** Extraction + write for a single venue -- shared by the population job and the revalidation job. */
export async function extractAndWriteVenue(
  candidateName: string,
  candidateAddress: string | undefined,
  candidateCategory: string,
  candidateSourceRef: string,
  options: PopulateNeighborhoodOptions,
) {
  const venue = await upsertCandidateAsVenue(candidateName, candidateAddress, candidateCategory, candidateSourceRef, options);

  const extraction = await extractVenueSignalsAndAttributes(venue.name, venue.neighborhood, venue.city);
  if (!extraction) {
    logger.warn({ venueId: venue.id, venueName: venue.name }, "Extraction pass produced no result; venue left with no signals/attributes");
    return null;
  }

  await upsertVenueSignalsAndAttributes(venue.id, extraction);

  // Closure suppression happens immediately, same as the revalidation job --
  // a freshly-extracted "this place is closed" signal should never sit
  // around waiting for review before it stops being recommendable.
  await db
    .update(venuesTable)
    .set({
      closureSuspected: extraction.closureSuspected,
      // Never silently move a venue OUT of pending_review here -- population always lands at pending_review;
      // closure suppression on a never-reviewed venue just keeps it excluded from lookups (see lookup.ts), it doesn't change tier.
    })
    .where(eq(venuesTable.id, venue.id));

  await recomputeVenueScore(venue.id);

  return venue;
}
