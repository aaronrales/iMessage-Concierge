import { and, eq, inArray, or } from "drizzle-orm";
import { db, venueAttributesTable, venuesTable, type Venue } from "@workspace/db";
import { type GroupConstraints, groupBudgetCeiling } from "../tasteEngine";

export interface CorpusLookupResult {
  venue: Venue;
  hedge: boolean; // true for Tier 2 -- caller should hedge language, never state it as confidently as Tier 1
}

// ─── Constraint compatibility scoring ─────────────────────────────────────────

/**
 * Keywords in `dietary_breadth` attribute notes that indicate a venue
 * handles a given dietary need well. Checked case-insensitively.
 */
const DIETARY_POSITIVE_KEYWORDS: Record<string, string[]> = {
  vegan: ["vegan", "plant-based", "plant based"],
  vegetarian: ["vegetarian", "vegan", "plant-based", "plant based"],
  "gluten-free": ["gluten-free", "gluten free", "celiac", "gf option"],
  "gluten free": ["gluten-free", "gluten free", "celiac", "gf option"],
  halal: ["halal"],
  kosher: ["kosher"],
  "dairy-free": ["dairy-free", "dairy free", "vegan"],
  "nut-free": ["nut-free", "nut free", "allergen"],
};

/** Keywords that suggest a venue is expensive regardless of which attribute they appear in. */
const EXPENSIVE_MARKERS = ["very expensive", "splurge", "$$$$", "$$$", "high-end", "upscale", "fine dining", "pricey"];
/** Keywords that suggest a venue is budget-friendly. */
const AFFORDABLE_MARKERS = ["affordable", "cheap", "budget", "inexpensive", "$$", "casual", "laid-back", "no-frills"];

/**
 * Computes a compatibility boost (0–15 composite-score points) for a venue
 * given the group's structured constraints and its extracted attributes.
 * A boost of 0 means "no known constraints to satisfy or no attribute data".
 * A negative boost penalizes venues that actively conflict with constraints.
 */
function computeConstraintBoost(
  constraints: GroupConstraints,
  attributesByDimension: Map<string, string>,
): number {
  let boost = 0;

  // ── Dietary needs ──────────────────────────────────────────────────────────
  const dietaryNote = attributesByDimension.get("dietary_breadth")?.toLowerCase() ?? "";
  if (dietaryNote && constraints.dietaryNeeds.length > 0) {
    let dietaryScore = 0;
    for (const need of constraints.dietaryNeeds) {
      const positiveKws = DIETARY_POSITIVE_KEYWORDS[need] ?? [need];
      const matched = positiveKws.some((kw) => dietaryNote.includes(kw));
      // "limited", "no", "not" before the keyword are hard negatives.
      const hardNegative = new RegExp(`\\b(no|not|limited|lacks?)\\b.{0,30}${positiveKws[0]}`, "i").test(dietaryNote);
      if (hardNegative) {
        dietaryScore -= 1;
      } else if (matched) {
        dietaryScore += 1;
      }
    }
    // Scale dietary boost: up to +8 for full match, down to -8 for hard conflict.
    boost += Math.max(-8, Math.min(8, (dietaryScore / constraints.dietaryNeeds.length) * 8));
  }

  // ── Budget / price ceiling ─────────────────────────────────────────────────
  const ceiling = groupBudgetCeiling(constraints.budgetTiers);
  if (ceiling < Infinity) {
    const priceNote = attributesByDimension.get("price_honesty")?.toLowerCase() ?? "";
    if (priceNote) {
      const isExpensive = EXPENSIVE_MARKERS.some((m) => priceNote.includes(m));
      const isAffordable = AFFORDABLE_MARKERS.some((m) => priceNote.includes(m));
      if (isExpensive && ceiling <= 2) {
        boost -= 6; // budget group, pricey venue
      } else if (isAffordable && ceiling <= 2) {
        boost += 4; // budget group, affordable venue
      }
    }
  }

  // ── Party size / group-friendliness ────────────────────────────────────────
  if (constraints.partySize >= 6) {
    const groupNote = attributesByDimension.get("group_friendliness")?.toLowerCase() ?? "";
    if (groupNote) {
      const isGroupFriendly = /\b(great|good|large group|private room|big party|reservations? for|group-friendly|accommodates)\b/.test(groupNote);
      const isUnfriendly = /\b(small|intimate|cozy|cramped|tight|no large|no group)\b/.test(groupNote);
      if (isGroupFriendly) boost += 5;
      if (isUnfriendly) boost -= 4;
    }
  }

  // ── Preferences (outdoor seating, quiet, etc.) ─────────────────────────────
  for (const pref of constraints.preferences) {
    const prefLower = pref.toLowerCase();
    if (prefLower.includes("outdoor") || prefLower.includes("patio")) {
      const outdoorNote = attributesByDimension.get("outdoor_seating")?.toLowerCase() ?? "";
      if (outdoorNote) {
        const hasOutdoor = /\b(patio|outdoor|terrace|rooftop|al fresco|garden)\b/.test(outdoorNote);
        if (hasOutdoor) boost += 3;
      }
    }
    if (prefLower.includes("quiet")) {
      const noiseNote = attributesByDimension.get("noise_level")?.toLowerCase() ?? "";
      if (noiseNote && /\b(quiet|calm|peaceful|mellow)\b/.test(noiseNote)) {
        boost += 2;
      }
    }
  }

  return boost;
}

// ─── Outdoor detection ────────────────────────────────────────────────────────

/**
 * Returns true if the corpus record for this venue has a confirmed outdoor /
 * patio attribute. Used by the weather-rescue scanner to decide whether a
 * confirmed plan needs an indoor-alternative nudge when rain is forecast.
 * Silently returns false for unrecognized venues (not in corpus → no attribute
 * data → we can't tell → don't falsely flag as outdoor).
 */
export async function isVenueOutdoor(venueName: string, neighborhood?: string): Promise<boolean> {
  const rows = await db
    .select({ id: venuesTable.id })
    .from(venuesTable)
    .where(
      neighborhood
        ? and(eq(venuesTable.name, venueName), eq(venuesTable.neighborhood, neighborhood))
        : eq(venuesTable.name, venueName),
    );

  const venueId = rows[0]?.id;
  if (!venueId) return false;

  const [attrRow] = await db
    .select({ value: venueAttributesTable.value })
    .from(venueAttributesTable)
    .where(and(eq(venueAttributesTable.venueId, venueId), eq(venueAttributesTable.dimension, "outdoor_seating")));

  if (!attrRow) return false;
  const note = (attrRow.value?.["note"] as string | undefined)?.toLowerCase() ?? "";
  // Explicit negatives evaluated FIRST: a note like "no patio, but indoor
  // seating available" still contains "patio" and would match the positive
  // regex if checked second. Negatives win over incidental keyword matches.
  if (/\b(no outdoor|no patio|no terrace|no outside|indoor only|entirely indoor)\b/.test(note)) return false;
  // Only after ruling out negatives, check for confirmed positive markers.
  if (/\b(patio|outdoor|terrace|rooftop|al fresco|garden|sidewalk)\b/.test(note)) return true;
  return false;
}

/**
 * Finds indoor alternatives (no outdoor / patio attribute, or attribute
 * explicitly says indoor-only) in the same neighborhood or borough. Used by
 * the weather-rescue message to give the group 2-3 concrete options.
 *
 * Returns up to `limit` Tier1/Tier2 non-outdoor venues. Falls back to any
 * non-closure-suspected venue if fewer than `limit` are found with the
 * strict indoor filter.
 */
export async function lookupIndoorAlternatives(
  neighborhoodOrCity: string,
  excludeVenueName: string | null,
  limit = 3,
): Promise<CorpusLookupResult[]> {
  const rows = await db
    .select()
    .from(venuesTable)
    .where(and(or(eq(venuesTable.tier, "tier1"), eq(venuesTable.tier, "tier2")), eq(venuesTable.closureSuspected, false)));

  const normalized = neighborhoodOrCity.toLowerCase().trim();
  const excludeNorm = excludeVenueName?.toLowerCase() ?? null;

  const candidates = rows.filter((v) => {
    if (excludeNorm && v.name.toLowerCase() === excludeNorm) return false;
    return (
      v.neighborhood.toLowerCase().includes(normalized) ||
      v.city.toLowerCase().includes(normalized) ||
      (v.borough?.toLowerCase().includes(normalized) ?? false)
    );
  });

  if (candidates.length === 0) return [];

  // Fetch outdoor_seating attributes for all candidates in one query.
  const venueIds = candidates.map((v) => v.id);
  const attrRows = await db
    .select({ venueId: venueAttributesTable.venueId, value: venueAttributesTable.value })
    .from(venueAttributesTable)
    .where(and(inArray(venueAttributesTable.venueId, venueIds), eq(venueAttributesTable.dimension, "outdoor_seating")));

  const outdoorNoteByVenueId = new Map(
    attrRows.map((r) => [r.venueId, (r.value?.["note"] as string | undefined)?.toLowerCase() ?? ""]),
  );

  // Prefer venues whose outdoor_seating note doesn't confirm outdoor seating.
  // Check negations first so "no patio" is treated as indoor, not outdoor.
  const indoor = candidates.filter((v) => {
    const note = outdoorNoteByVenueId.get(v.id) ?? "";
    // Explicit negatives → definitely indoor
    if (/\b(no outdoor|no patio|no terrace|no outside|indoor only|entirely indoor)\b/.test(note)) return true;
    // Confirmed outdoor markers → exclude from indoor pool
    if (/\b(patio|outdoor seating|terrace|rooftop|al fresco|garden|sidewalk)\b/.test(note)) return false;
    // No attribute or ambiguous → treat as indoor (safe default for alternatives)
    return true;
  });

  const pool = indoor.length >= limit ? indoor : candidates; // fall back if not enough indoor results
  const sorted = pool.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "tier1" ? -1 : 1;
    return Number(b.compositeScore ?? 0) - Number(a.compositeScore ?? 0);
  });

  return sorted.slice(0, limit).map((v) => ({ venue: v, hedge: v.tier === "tier2" }));
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Agent-facing corpus lookup: Tier 1 preferred, Tier 2 included but flagged
 * for hedged language, `pending_review`/`untiered`/closure-suspected venues
 * never returned. This is queried BEFORE the Google Places fallback in
 * `tools.ts` -- the corpus is the source of truth once it has anything for
 * a query; the raw search is only a stopgap for markets/queries the corpus
 * hasn't covered yet.
 *
 * When `groupConstraints` are provided, each matched venue's attributes are
 * fetched in a single batch query and a compatibility boost is computed.
 * Venues that actively conflict with hard constraints (e.g. no dietary
 * options for a vegan group member) are penalised in ranking; venues that
 * confirm compatibility get a positive boost. This means the LLM prompt's
 * group constraint summary acts as a soft hint while the ranking layer does
 * the real filtering work.
 */
export async function lookupCorpusVenues(
  query: string,
  neighborhoodOrCity?: string,
  limit = 5,
  groupConstraints?: GroupConstraints,
): Promise<CorpusLookupResult[]> {
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

  if (matches.length === 0) return [];

  // ── Constraint-aware ranking ───────────────────────────────────────────────
  // When group constraints are present, fetch all attribute rows for matched
  // venues in a single batch query, compute a compatibility boost per venue,
  // and adjust the effective composite score used for final ranking.
  let boostByVenueId: Map<number, number> = new Map();

  if (groupConstraints) {
    const venueIds = matches.map((v) => v.id);
    const attributeRows = await db
      .select()
      .from(venueAttributesTable)
      .where(inArray(venueAttributesTable.venueId, venueIds));

    // Build venueId → dimension → note map.
    const attrsByVenue = new Map<number, Map<string, string>>();
    for (const row of attributeRows) {
      if (!attrsByVenue.has(row.venueId)) attrsByVenue.set(row.venueId, new Map());
      const note = typeof row.value?.["note"] === "string" ? (row.value["note"] as string) : "";
      attrsByVenue.get(row.venueId)!.set(row.dimension, note);
    }

    // Compute boost for each matched venue.
    for (const venue of matches) {
      const attrs = attrsByVenue.get(venue.id) ?? new Map<string, string>();
      boostByVenueId.set(venue.id, computeConstraintBoost(groupConstraints, attrs));
    }
  }

  // Sort: Tier 1 before Tier 2; within each tier, by (compositeScore + constraintBoost).
  const sorted = matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "tier1" ? -1 : 1;
    const scoreA = Number(a.compositeScore ?? 0) + (boostByVenueId.get(a.id) ?? 0);
    const scoreB = Number(b.compositeScore ?? 0) + (boostByVenueId.get(b.id) ?? 0);
    return scoreB - scoreA;
  });

  return sorted.slice(0, limit).map((venue) => ({ venue, hedge: venue.tier === "tier2" }));
}
