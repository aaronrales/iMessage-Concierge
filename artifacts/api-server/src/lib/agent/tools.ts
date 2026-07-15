import type OpenAI from "openai";
import { logger } from "../logger";
import { lookupCorpusVenues } from "./venueCorpus/lookup";
import { logRecommendationEvent } from "./venueCorpus/recommendationLog";

/**
 * Tool contract for venue/activity lookups. Phase 1 backs this with a real
 * Yelp Fusion API call (see `searchVenuesViaYelp` below); the shape returned
 * to the model is unchanged from the Phase 0 stub so the calling convention
 * in `engine.ts` never needed to change.
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

const YELP_BASE_URL = "https://api.yelp.com/v3/businesses/search";
const YELP_PRICE_SYMBOLS = ["", "$", "$", "$$", "$$"];

interface YelpBusiness {
  name: string;
  url: string;
  price?: string;
  categories?: { title: string }[];
  hours?: { open?: { start: string; end: string; day: number }[]; is_open_now?: boolean }[];
}

interface YelpSearchResponse {
  businesses?: YelpBusiness[];
}

function summarizeYelpHours(business: YelpBusiness): string {
  const hoursBlock = business.hours?.[0];
  if (!hoursBlock) return "hours unknown";
  if (hoursBlock.is_open_now) return "open now";
  if (!hoursBlock.open?.length) return "hours unknown";
  return "see link for hours";
}

/**
 * Calls the Yelp Fusion business search API. Returns `null` (rather than
 * throwing) whenever the key is missing, the request fails, or Yelp returns
 * zero results, so a lookup miss degrades to a clear "nothing found" message
 * instead of breaking the agent turn.
 */
async function searchVenuesViaYelp(args: { query: string; location?: string }): Promise<VenueResult[] | null> {
  const apiKey = process.env["YELP_API_KEY"];
  if (!apiKey) {
    logger.warn("YELP_API_KEY is not configured; venue lookups are unavailable");
    return null;
  }

  const url = new URL(YELP_BASE_URL);
  url.searchParams.set("term", args.query);
  url.searchParams.set("location", args.location?.trim() || "United States");
  url.searchParams.set("limit", "5");

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error({ status: response.status, body }, "Yelp Fusion API request failed");
      return null;
    }

    const data = (await response.json()) as YelpSearchResponse;
    const businesses = data.businesses ?? [];
    if (businesses.length === 0) return null;

    return businesses.map((business) => ({
      name: business.name,
      category: business.categories?.map((c) => c.title).join(", ") || "unknown",
      priceLevel: business.price ?? (YELP_PRICE_SYMBOLS[0] as string),
      hours: summarizeYelpHours(business),
      link: business.url,
    }));
  } catch (error) {
    logger.error({ error }, "Yelp Fusion API request threw an error");
    return null;
  }
}

export interface VenueCandidate {
  name: string;
  category: string;
  address?: string;
  sourceRef: string;
}

interface YelpBusinessWithLocation extends YelpBusiness {
  id?: string;
  location?: { display_address?: string[] };
}

/**
 * Candidate sourcing for the venue corpus population job (see
 * `lib/agent/venueCorpus/population.ts`) -- reuses the same Yelp integration
 * `search_venues` is backed by, so there's exactly one place that talks to
 * Yelp. Returns raw candidates for the LLM extraction pipeline to research
 * further; never returned directly to the concierge agent.
 */
export async function listVenueCandidates(query: string, location: string, limit = 20): Promise<VenueCandidate[]> {
  const apiKey = process.env["YELP_API_KEY"];
  if (!apiKey) {
    logger.warn("YELP_API_KEY is not configured; venue candidate sourcing is unavailable");
    return [];
  }

  const url = new URL(YELP_BASE_URL);
  url.searchParams.set("term", query);
  url.searchParams.set("location", location);
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));

  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error({ status: response.status, body }, "Yelp Fusion API candidate search failed");
      return [];
    }
    const data = (await response.json()) as { businesses?: YelpBusinessWithLocation[] };
    return (data.businesses ?? []).map((business) => ({
      name: business.name,
      category: business.categories?.map((c) => c.title).join(", ") || "unknown",
      address: business.location?.display_address?.join(", "),
      sourceRef: business.id ?? business.url,
    }));
  } catch (error) {
    logger.error({ error, query, location }, "Yelp Fusion API candidate search threw an error");
    return [];
  }
}

/**
 * Executes a tool call. `threadId` is optional context (not something the
 * model provides) used to log recommendation events for the venue corpus --
 * every `search_venues` call that surfaces a corpus-backed venue is logged
 * as "shown", even though ranking doesn't consume that data yet.
 */
export async function executeAgentTool(name: string, rawArgs: string, threadId?: number): Promise<unknown> {
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
      const corpusMatches = await lookupCorpusVenues(query, location);
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

      // Fallback: the corpus has nothing for this query/market yet, so fall back to the raw Yelp lookup rather than refusing to help.
      const results = await searchVenuesViaYelp({ query, location });
      if (!results) {
        return {
          results: [],
          note: "No real venue data available for this query (curated corpus has nothing here, and the Yelp fallback lookup returned nothing or is not configured). Do not invent a specific venue -- speak generally instead, or ask the person for more detail.",
        };
      }
      return { results, note: "These come from a general lookup, not our curated corpus -- speak about them slightly more tentatively than a vetted recommendation." };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
