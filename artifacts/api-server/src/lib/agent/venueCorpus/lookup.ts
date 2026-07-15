import { and, eq, or } from "drizzle-orm";
import { db, venuesTable, type Venue } from "@workspace/db";

export interface CorpusLookupResult {
  venue: Venue;
  hedge: boolean; // true for Tier 2 -- caller should hedge language, never state it as confidently as Tier 1
}

/**
 * Agent-facing corpus lookup: Tier 1 preferred, Tier 2 included but flagged
 * for hedged language, `pending_review`/`untiered`/closure-suspected venues
 * never returned. This is queried BEFORE the raw Yelp fallback in
 * `tools.ts` -- the corpus is the source of truth once it has anything for
 * a query, the raw search is only a stopgap for markets/queries the corpus
 * hasn't covered yet.
 */
export async function lookupCorpusVenues(query: string, neighborhoodOrCity?: string, limit = 5): Promise<CorpusLookupResult[]> {
  const rows = await db
    .select()
    .from(venuesTable)
    .where(and(or(eq(venuesTable.tier, "tier1"), eq(venuesTable.tier, "tier2")), eq(venuesTable.closureSuspected, false)));

  const normalizedQuery = query.toLowerCase();
  const normalizedLocation = neighborhoodOrCity?.toLowerCase().trim();

  const matches = rows.filter((venue) => {
    const haystack = `${venue.name} ${venue.category ?? ""} ${venue.venueType}`.toLowerCase();
    const matchesQuery = normalizedQuery
      .split(/\s+/)
      .filter(Boolean)
      .some((term) => haystack.includes(term));
    const matchesLocation = !normalizedLocation
      ? true
      : venue.neighborhood.toLowerCase().includes(normalizedLocation) ||
        venue.city.toLowerCase().includes(normalizedLocation) ||
        (venue.borough?.toLowerCase().includes(normalizedLocation) ?? false);
    return matchesQuery && matchesLocation;
  });

  // Tier 1 first, then by composite score within each tier.
  const sorted = matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "tier1" ? -1 : 1;
    return Number(b.compositeScore ?? 0) - Number(a.compositeScore ?? 0);
  });

  return sorted.slice(0, limit).map((venue) => ({ venue, hedge: venue.tier === "tier2" }));
}
