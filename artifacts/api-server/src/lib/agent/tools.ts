import type OpenAI from "openai";
import { logger } from "../logger";
import { lookupCorpusVenues } from "./venueCorpus/lookup";
import { logRecommendationEvent } from "./venueCorpus/recommendationLog";
import type { GroupConstraints } from "./tasteEngine";

/**
 * Metadata collected for each corpus venue returned by `search_venues` so
 * the delivery layer can send photo carousels alongside the text reply.
 */
export interface VenueCarouselEntry {
  venueId: number;
  venueName: string;
  /** Null when the venue has no stored Google Place ID; delivery falls back to a text-search lookup. */
  googlePlaceId: string | null;
}

// ─── Google Places Photo fetch ────────────────────────────────────────────────

/**
 * Fetches up to `maxPhotos` HTTPS photo URLs for a Google Place by its ID.
 * Uses the Places New API: first retrieves photo references from the place
 * detail endpoint, then resolves each to a hosted media URI via
 * `skipHttpRedirect=true` so we get a JSON response instead of a redirect.
 * Returns an empty array on any failure so callers can skip carousels safely.
 */
export async function fetchGooglePlacesPhotos(placeId: string, maxPhotos = 4): Promise<string[]> {
  const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
  if (!apiKey) return [];

  try {
    // Step 1: Get photo name references for this place.
    const detailResp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "photos",
      },
    });
    if (!detailResp.ok) {
      logger.warn({ placeId, status: detailResp.status }, "Google Places detail fetch failed");
      return [];
    }

    const detail = (await detailResp.json()) as { photos?: { name: string }[] };
    const photoRefs = (detail.photos ?? []).slice(0, maxPhotos);
    if (photoRefs.length === 0) return [];

    // Step 2: Resolve each photo reference to a hosted URI.
    const urls: string[] = [];
    for (const photo of photoRefs) {
      try {
        const mediaResp = await fetch(
          `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=1200&skipHttpRedirect=true&key=${apiKey}`,
        );
        if (!mediaResp.ok) continue;
        const mediaData = (await mediaResp.json()) as { photoUri?: string };
        if (mediaData.photoUri) urls.push(mediaData.photoUri);
      } catch {
        // Skip individual photo failures; surface what we have.
      }
    }
    return urls;
  } catch (error) {
    logger.warn({ error, placeId }, "Google Places photo fetch threw an error");
    return [];
  }
}

/**
 * Resolves a venue name (and optional neighborhood) to a Google Place ID via
 * a text search. Used as a fallback when a corpus venue has no stored
 * `googlePlaceId`. Returns null on any failure.
 */
export async function findGooglePlaceIdByName(venueName: string, neighborhood?: string): Promise<string | null> {
  const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
  if (!apiKey) return null;

  const textQuery = neighborhood ? `${venueName} ${neighborhood}` : venueName;
  try {
    const response = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id",
      },
      body: JSON.stringify({ textQuery, maxResultCount: 1 }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { places?: { id?: string }[] };
    return data.places?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Tool contract for venue/activity lookups. Backed by the curated corpus
 * first; falls back to a live Google Places Text Search when the corpus has
 * nothing for a given query/market. The shape returned to the model is
 * unchanged from the original design so the calling convention in `engine.ts`
 * never needs to change.
 */
export const AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_venues",
      description:
        "Look up real venues or activities matching a query (e.g. a cuisine, an area, an activity type). Use this whenever you're about to suggest a specific place so you don't invent one.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for, e.g. 'cheap thai food' or 'rooftop bar'.",
          },
          location: {
            type: "string",
            description: "Neighborhood or city to search near, if known.",
          },
        },
        required: ["query"],
      },
    },
  },
];

interface VenueResult {
  name: string;
  category: string;
  priceLevel: string;
  hours: string;
  link: string;
}

// ─── Google Places New API ────────────────────────────────────────────────────

const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/** Maps Google Places price level enum → human-readable symbol. */
function mapGooglePriceLevel(level: string | undefined): string {
  switch (level) {
    case "PRICE_LEVEL_FREE":
    case "PRICE_LEVEL_INEXPENSIVE":
      return "$";
    case "PRICE_LEVEL_MODERATE":
      return "$$";
    case "PRICE_LEVEL_EXPENSIVE":
      return "$$$";
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return "$$$$";
    default:
      return "unknown";
  }
}

/** Maps an array of Google Places types → a readable category string. */
function mapGoogleTypes(types: string[] | undefined): string {
  if (!types?.length) return "unknown";
  // Prefer food/hospitality types over generic ones.
  const preferred = types.find(
    (t) => !["point_of_interest", "establishment", "food", "store"].includes(t),
  );
  return (preferred ?? types[0] ?? "unknown").replace(/_/g, " ");
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  types?: string[];
  priceLevel?: string;
  regularOpeningHours?: { openNow?: boolean };
  googleMapsUri?: string;
}

interface GoogleTextSearchResponse {
  places?: GooglePlace[];
}

/**
 * Calls the Google Places Text Search API (New). Returns `null` (rather than
 * throwing) whenever the key is missing, the request fails, or Places returns
 * zero results, so a lookup miss degrades gracefully.
 */
async function searchVenuesViaGooglePlaces(args: { query: string; location?: string }): Promise<VenueResult[] | null> {
  const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
  if (!apiKey) {
    logger.warn("GOOGLE_PLACES_API_KEY is not configured; venue lookups are unavailable");
    return null;
  }

  const textQuery = args.location ? `${args.query} in ${args.location}` : args.query;

  try {
    const response = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.types,places.priceLevel,places.regularOpeningHours,places.googleMapsUri",
      },
      body: JSON.stringify({ textQuery, maxResultCount: 5 }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error({ status: response.status, body }, "Google Places API request failed");
      return null;
    }

    const data = (await response.json()) as GoogleTextSearchResponse;
    const places = data.places ?? [];
    if (places.length === 0) return null;

    return places
      .filter((p) => p.displayName?.text)
      .map((place) => ({
        name: place.displayName!.text!,
        category: mapGoogleTypes(place.types),
        priceLevel: mapGooglePriceLevel(place.priceLevel),
        hours: place.regularOpeningHours?.openNow === true ? "open now" : "see link for hours",
        link: place.googleMapsUri ?? "",
      }));
  } catch (error) {
    logger.error({ error }, "Google Places API request threw an error");
    return null;
  }
}

// ─── Corpus population candidate sourcing ────────────────────────────────────

export interface VenueCandidate {
  name: string;
  category: string;
  address?: string;
  sourceRef: string;
}

/**
 * Candidate sourcing for the venue corpus population job (see
 * `lib/agent/venueCorpus/population.ts`) -- uses Google Places Text Search
 * to discover real venues for a neighborhood/borough. Returns raw candidates
 * for the LLM extraction pipeline to research further; never returned
 * directly to the concierge agent.
 */
export async function listVenueCandidates(query: string, location: string, limit = 20): Promise<VenueCandidate[]> {
  const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
  if (!apiKey) {
    logger.warn("GOOGLE_PLACES_API_KEY is not configured; venue candidate sourcing is unavailable");
    return [];
  }

  const textQuery = `${query} in ${location}`;

  try {
    const response = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.types",
      },
      body: JSON.stringify({ textQuery, maxResultCount: Math.min(20, Math.max(1, limit)) }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error({ status: response.status, body }, "Google Places API candidate search failed");
      return [];
    }

    const data = (await response.json()) as GoogleTextSearchResponse;
    return (data.places ?? [])
      .filter((p) => p.displayName?.text && p.id)
      .map((place) => ({
        name: place.displayName!.text!,
        category: mapGoogleTypes(place.types),
        address: place.formattedAddress,
        sourceRef: place.id!,
      }));
  } catch (error) {
    logger.error({ error, query, location }, "Google Places API candidate search threw an error");
    return [];
  }
}

// ─── Tool executor ─────────────────────────────────────────────────────────────

/**
 * Executes a tool call. `threadId` is optional context (not something the
 * model provides) used to log recommendation events for the venue corpus.
 * `groupConstraints` is also optional context -- when provided, corpus results
 * are filtered and boosted by the group's dietary needs, budget, and party
 * size before being returned to the model.
 */
/**
 * Executes a tool call. `threadId` is optional context (not something the
 * model provides) used to log recommendation events for the venue corpus.
 * `groupConstraints` is also optional context -- when provided, corpus results
 * are filtered and boosted by the group's dietary needs, budget, and party
 * size before being returned to the model.
 *
 * `venueCarouselAccumulator`, when provided, is populated with corpus venues
 * returned by `search_venues` so the delivery layer can follow up the text
 * reply with per-venue photo carousels.
 */
export async function executeAgentTool(
  name: string,
  rawArgs: string,
  threadId?: number,
  groupConstraints?: GroupConstraints,
  venueCarouselAccumulator?: VenueCarouselEntry[],
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return { error: "Failed to parse tool arguments" };
  }

  switch (name) {
    case "search_venues": {
      const query = typeof args["query"] === "string" ? (args["query"] as string) : "";
      const location = typeof args["location"] === "string" ? (args["location"] as string) : undefined;

      // Curated corpus first: Tier 1 preferred, Tier 2 included but hedged,
      // pending_review/untiered/closure-suspected venues never surfaced.
      // Group constraints (dietary needs, budget, party size) are applied as
      // a filter+boost layer inside lookupCorpusVenues when provided.
      const corpusMatches = await lookupCorpusVenues(query, location, 5, groupConstraints);
      if (corpusMatches.length > 0) {
        if (threadId !== undefined) {
          await Promise.all(
            corpusMatches.map((match) =>
              logRecommendationEvent({
                venueId: match.venue.id,
                threadId,
                outcome: "shown",
                context: { query, location, tier: match.venue.tier },
              }),
            ),
          );
        }

        // Populate the carousel accumulator so the delivery layer can send
        // photo carousels alongside the text recommendation (best-effort;
        // only corpus venues have the IDs needed for photo lookup).
        if (venueCarouselAccumulator) {
          for (const match of corpusMatches) {
            venueCarouselAccumulator.push({
              venueId: match.venue.id,
              venueName: match.venue.name,
              googlePlaceId: match.venue.googlePlaceId ?? null,
            });
          }
        }

        return {
          results: corpusMatches.map((match) => ({
            name: match.venue.name,
            category: match.venue.category ?? match.venue.venueType,
            neighborhood: match.venue.neighborhood,
            confidenceHedge: match.hedge,
          })),
          note: corpusMatches.some((m) => m.hedge)
            ? "Some of these are Tier 2 in our curated venue corpus -- speak about them with a bit less certainty (e.g. 'reportedly good' rather than a flat recommendation) than the Tier 1 ones."
            : "These are Tier 1 in our curated venue corpus -- vetted and safe to recommend confidently.",
        };
      }

      // Fallback: corpus has nothing for this query/market yet. Use Google Places
      // rather than refusing to help.
      const results = await searchVenuesViaGooglePlaces({ query, location });
      if (!results) {
        return {
          results: [],
          note: "No real venue data available for this query (curated corpus has nothing here, and the Google Places fallback returned nothing or is not configured). Do not invent a specific venue -- speak generally instead, or ask the person for more detail.",
        };
      }
      return { results, note: "These come from a general lookup, not our curated corpus -- speak about them slightly more tentatively than a vetted recommendation." };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
