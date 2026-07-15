import type OpenAI from "openai";

/**
 * Tool contract for venue/activity lookups. The Phase 0 implementation below
 * is a placeholder so the tool-calling round trip exists end-to-end; Phase 1
 * swaps the body for a real Yelp Fusion (or Google Places) call without
 * needing to touch the calling convention in `engine.ts`.
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

interface StubVenueResult {
  name: string;
  category: string;
  priceLevel: string;
  hours: string;
  link: string;
}

/**
 * Placeholder tool implementation. Returns clearly-labeled synthetic results
 * so nothing downstream mistakes these for real venue data -- Phase 1
 * ("Real venue/activity recommendations") replaces this with an actual Yelp
 * Fusion API call and should keep the same input/output shape.
 */
function searchVenuesStub(args: { query: string; location?: string }): StubVenueResult[] {
  const locationSuffix = args.location ? ` near ${args.location}` : "";
  return [
    {
      name: `[placeholder result for "${args.query}"${locationSuffix}]`,
      category: "unknown -- real lookup not wired up yet",
      priceLevel: "unknown",
      hours: "unknown",
      link: "https://example.com/placeholder",
    },
  ];
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
      return { results: searchVenuesStub({ query, location }) };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
