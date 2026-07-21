import type OpenAI from "openai";
import { logger } from "../logger";
import { lookupCorpusVenues } from "./venueCorpus/lookup";
import { logRecommendationEvent } from "./venueCorpus/recommendationLog";
import type { GroupConstraints } from "./tasteEngine";
import { logToolOutcome, classifyOutcome, type ToolOutcome } from "./toolOutcomeLogger";

/**
 * Metadata collected for each venue returned by `search_venues` or
 * `search_lodging` so the delivery layer can send photo carousels alongside
 * the text reply. Works for both corpus hits and Google Places fallback results.
 */
export interface VenueCarouselEntry {
  /** DB venue ID for corpus hits; undefined for Google Places fallback results. */
  venueId?: number;
  venueName: string;
  /** Google Place ID used by the delivery layer to fetch photos. Null for corpus
   * venues that pre-date Place ID storage — delivery falls back to a name search. */
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
// ─── CAPABILITY AUDIT ────────────────────────────────────────────────────────
// REQUIRED REVIEW: whenever the system prompt in engine.ts is edited, verify
// this list matches every tool/capability the agent can actually invoke.
// Mismatches are the #1 source of promise-without-delivery failures.
//
//   ✅ search_venues   — corpus + Google Places fallback
//   ✅ search_lodging  — Google Places hotel search + booking links
//   ❌ search_flights  — NOT available; use deep-link / collect-only pattern
//   ✅ JIT extraction  — async background venue extraction for non-NYC destinations

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
  {
    type: "function",
    function: {
      name: "search_lodging",
      description:
        "Look up real hotel and lodging options for a destination. Call this whenever the user asks about hotels, places to stay, or where to book — never promise lodging results without calling this first so you don't invent options that don't exist.",
      parameters: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            description: "City or destination to search in, e.g. 'Lake Como, Italy' or 'Nashville, TN'.",
          },
          price_band: {
            type: "string",
            enum: ["budget", "mid", "luxury"],
            description: "Target price tier. Omit to return a spread across tiers.",
          },
          checkin: {
            type: "string",
            description: "Check-in date in ISO format (YYYY-MM-DD), if known.",
          },
          checkout: {
            type: "string",
            description: "Check-out date in ISO format (YYYY-MM-DD), if known.",
          },
          guests: {
            type: "number",
            description: "Number of guests, if known.",
          },
        },
        required: ["destination"],
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

/** Internal-only: VenueResult enriched with the Google Place ID for carousel use.
 *  The placeId field is stripped before the result is returned to the model. */
interface GoogleVenueResult extends VenueResult {
  placeId: string;
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
async function searchVenuesViaGooglePlaces(args: { query: string; location?: string }): Promise<GoogleVenueResult[] | null> {
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
      .filter((p) => p.displayName?.text && p.id)
      .map((place) => ({
        name: place.displayName!.text!,
        category: mapGoogleTypes(place.types),
        priceLevel: mapGooglePriceLevel(place.priceLevel),
        hours: place.regularOpeningHours?.openNow === true ? "open now" : "see link for hours",
        link: place.googleMapsUri ?? "",
        placeId: place.id!,
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

// ─── Lodging search ───────────────────────────────────────────────────────────

interface LodgingResult {
  name: string;
  category: string;
  priceLevel: string;
  address: string;
  googleMapsLink: string;
}

/** Internal-only: LodgingResult enriched with the Google Place ID for carousel use.
 *  The placeId field is stripped before the result is returned to the model. */
interface LodgingResultWithPlaceId extends LodgingResult {
  placeId: string;
}

/** Maps price level to rough nightly cost band for context. */
function mapPriceLevelBand(level: string): string {
  switch (level) {
    case "$": return "budget";
    case "$": return "mid-range";
    case "$$": return "upscale";
    case "$$": return "luxury";
    default: return "unknown";
  }
}

/** Builds a hotel-specific Booking.com search URL (deep link, no scraping). */
function buildHotelBookingUrl(
  hotelName: string,
  destination: string,
  checkin: string | null,
  checkout: string | null,
  guests: number | null,
): string {
  const url = new URL("https://www.booking.com/searchresults.html");
  url.searchParams.set("ss", `${hotelName} ${destination}`);
  if (checkin) url.searchParams.set("checkin", checkin);
  if (checkout) url.searchParams.set("checkout", checkout);
  if (guests) {
    url.searchParams.set("group_adults", String(guests));
    url.searchParams.set("no_rooms", "1");
  }
  return url.toString();
}

/**
 * Searches Google Places for hotels/lodging at a destination.
 * Uses the Places Text Search API with lodging-type types.
 * Returns null on any failure so the caller can degrade gracefully.
 */
async function searchLodgingViaGooglePlaces(args: {
  destination: string;
  priceBand: string | null;
}): Promise<LodgingResultWithPlaceId[] | null> {
  const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
  if (!apiKey) {
    logger.warn("GOOGLE_PLACES_API_KEY not configured; lodging search unavailable");
    return null;
  }

  const bandModifier = args.priceBand === "budget" ? "affordable " : args.priceBand === "luxury" ? "luxury " : "";
  const textQuery = `${bandModifier}hotels in ${args.destination}`;

  try {
    const response = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.types,places.priceLevel,places.googleMapsUri",
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 5,
        // No includedTypes: the text query is specific enough, and a hard type
        // filter silently zeros out results in many well-covered markets (e.g.
        // Amsterdam) when Google's place classifications don't cleanly match.
      }),
    });

    if (!response.ok) {
      logger.error({ status: response.status, destination: args.destination }, "Google Places lodging search failed");
      return null;
    }

    const data = (await response.json()) as GoogleTextSearchResponse;
    const places = data.places ?? [];
    if (places.length === 0) return null;

    return places
      .filter((p) => p.displayName?.text && p.id)
      .slice(0, 3) // cap at 3 options so the message stays readable
      .map((place) => ({
        name: place.displayName!.text!,
        category: mapPriceLevelBand(mapGooglePriceLevel(place.priceLevel)),
        priceLevel: mapGooglePriceLevel(place.priceLevel),
        address: place.formattedAddress ?? "",
        googleMapsLink: place.googleMapsUri ?? "",
        placeId: place.id!,
      }));
  } catch (error) {
    logger.error({ error, destination: args.destination }, "Google Places lodging search threw an error");
    return null;
  }
}

// ─── Tool executor ─────────────────────────────────────────────────────────────

/**
 * Inner implementation of the tool executor. All tool logic lives here;
 * `executeAgentTool` wraps it to add timing and outcome logging.
 */
async function _executeAgentToolImpl(
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
      // Populate the carousel accumulator for Google Places fallback results.
      // The placeId comes directly from the Places API so no extra lookup is needed.
      if (venueCarouselAccumulator) {
        for (const r of results) {
          venueCarouselAccumulator.push({ venueName: r.name, googlePlaceId: r.placeId });
        }
      }
      // Strip the internal placeId before returning to the model.
      return {
        results: results.map(({ placeId: _placeId, ...rest }) => rest),
        note: "These come from a general lookup, not our curated corpus -- speak about them slightly more tentatively than a vetted recommendation.",
      };
    }
    case "search_lodging": {
      const destination = typeof args["destination"] === "string" ? args["destination"] : "";
      const priceBand = typeof args["price_band"] === "string" ? args["price_band"] : null;
      const checkin = typeof args["checkin"] === "string" ? args["checkin"] : null;
      const checkout = typeof args["checkout"] === "string" ? args["checkout"] : null;
      const guests = typeof args["guests"] === "number" ? Math.round(args["guests"]) : null;

      const results = await searchLodgingViaGooglePlaces({ destination, priceBand });
      if (!results || results.length === 0) {
        return {
          results: [],
          note: `No lodging data found for "${destination}". Suggest the user search Airbnb, VRBO, or Booking.com directly — the system can generate search deep links.`,
        };
      }

      // Populate the carousel accumulator so the delivery layer can send hotel
      // photo carousels alongside the text reply. placeId comes directly from
      // the Places API so no extra lookup is needed.
      if (venueCarouselAccumulator) {
        for (const r of results) {
          venueCarouselAccumulator.push({ venueName: r.name, googlePlaceId: r.placeId });
        }
      }

      // Build a Booking.com search URL for the destination (deep link, not an API).
      const bookingBase = new URL("https://www.booking.com/searchresults.html");
      bookingBase.searchParams.set("ss", destination);
      if (checkin) bookingBase.searchParams.set("checkin", checkin);
      if (checkout) bookingBase.searchParams.set("checkout", checkout);
      if (guests) {
        bookingBase.searchParams.set("group_adults", String(guests));
        bookingBase.searchParams.set("no_rooms", "1");
      }
      const bookingSearchUrl = bookingBase.toString();

      // Strip the internal placeId before returning to the model.
      return {
        results: results.map(({ placeId: _placeId, ...rest }) => ({
          ...rest,
          bookingSearchUrl: buildHotelBookingUrl(rest.name, destination, checkin, checkout, guests),
        })),
        searchUrl: bookingSearchUrl,
        note: "From Google Places — speak tentatively (e.g. 'Here are a few options I found') and note that prices/availability should be confirmed on the booking site.",
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Executes a tool call and logs a structured outcome record to `tool_call_log`.
 * Wraps `_executeAgentToolImpl` with timing and outcome classification so
 * every call is observable without changing any tool's return value or
 * error behaviour.
 *
 * Outcome tags:
 *   success       — tool returned non-empty results
 *   empty         — tool returned zero results (valid call, no data found)
 *   api_error     — the external API returned a non-OK response or threw
 *   not_configured — required env key was absent; call was not attempted
 */
export async function executeAgentTool(
  name: string,
  rawArgs: string,
  threadId?: number,
  groupConstraints?: GroupConstraints,
  venueCarouselAccumulator?: VenueCarouselEntry[],
): Promise<unknown> {
  const start = Date.now();

  // Detect a missing Google Places API key before the call so we can log
  // "not_configured" rather than "empty" (which would look like a data gap).
  const googleKeyMissing = !process.env["GOOGLE_PLACES_API_KEY"];
  const usesGooglePlaces = name === "search_venues" || name === "search_lodging";

  try {
    const result = await _executeAgentToolImpl(
      name,
      rawArgs,
      threadId,
      groupConstraints,
      venueCarouselAccumulator,
    );

    const outcome: ToolOutcome =
      usesGooglePlaces && googleKeyMissing ? "not_configured" : classifyOutcome(result);

    logToolOutcome(name, outcome, Date.now() - start, threadId);
    return result;
  } catch (err) {
    logToolOutcome(name, "api_error", Date.now() - start, threadId);
    throw err;
  }
}
