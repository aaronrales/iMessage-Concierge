import type OpenAI from "openai";
import { logger } from "../logger";

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

export async function executeAgentTool(name: string, rawArgs: string): Promise<unknown> {
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
      const results = await searchVenuesViaYelp({ query, location });
      if (!results) {
        return {
          results: [],
          note: "No real venue data available for this query (Yelp lookup returned nothing or is not configured). Do not invent a specific venue -- speak generally instead, or ask the person for more detail.",
        };
      }
      return { results };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
