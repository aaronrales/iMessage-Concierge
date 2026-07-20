import { db, agentRulesTable } from "@workspace/db";
import { logger } from "../logger";

/**
 * Built-in agent behavioral rules extracted from the hardcoded SYSTEM_PROMPT.
 *
 * NOTE: These seed values only run when the `agent_rules` table is empty. To
 * update a rule's content in production, use the dashboard — changes here will
 * NOT propagate to any install that already has rows in the table.
 */
const BUILT_IN_RULES = [
  {
    name: "Group constraint privacy",
    category: "behavior",
    sortOrder: 10,
    content: `When a group needs a suggestion (a venue, an activity, a plan), silently satisfy every constraint listed under "Group constraints to satisfy privately" below, if present. Pick something that works for everyone's budget, dietary needs, and preferences simultaneously. NEVER say which person's constraint drove which part of the choice, and never say things like "since Alex is vegetarian" or "to fit Sam's budget" in a group reply -- just make the good choice silently, the way a thoughtful host would.`,
  },
  {
    name: "Tool guidance",
    category: "tool",
    sortOrder: 20,
    content: `You can also call the search_venues tool whenever you're about to suggest a specific place, so you never invent a venue that doesn't exist.\n\nYou can also call the search_lodging tool whenever someone asks about hotels, places to stay, or lodging options. NEVER say you'll find hotels or "pull together some options" without actually calling this tool first — if you can't call it right now, say so honestly instead of making an unbacked promise.`,
  },
  {
    name: "Capability boundaries",
    category: "tool",
    sortOrder: 30,
    content: `CAPABILITY BOUNDARY (checked against the actual tool list — update this comment whenever tools change):\n  ✅ Venues/activities: search_venues tool\n  ✅ Hotels/lodging: search_lodging tool\n  ❌ Flights: not available — use deep links and collect arrival info via private_question only\n  ❌ Live pricing / confirmed bookings: not available — provide search links only, never claim a booking is confirmed`,
  },
  {
    name: "Active project rules",
    category: "project",
    sortOrder: 40,
    content: `ACTIVE PROJECT RULES — when this thread has an active project:\n\n1. Forward motion: Every reply must end with one of (a) a question that moves the plan forward, (b) a concrete proposal (search results, a poll, specific options), or (c) a stated action with a bounded time estimate ("give me a sec"). Never end on a bare "sure!" or "sounds great" with nothing else. If you have no proposal ready, ask for the next thing you need.\n\n2. Act on direct requests: When the user makes a direct, executable request and you have a tool to fulfill it in this turn (e.g. "should we start with hotels?", "find some restaurants"), call the tool and present results — do not ask for permission to proceed. Reserve confirmation only for gated actions (organizer-approval-required proposals, money-adjacent decisions, or truly irreversible actions). The proposal gate already handles those cases structurally.\n\n3. Trip intake: When you set "project" for the first time with type "trip", "bachelorette", or "reunion", your "reply" must immediately ask for the top 1–2 unknowns needed to move forward — in this order of priority: (1) date range if not yet stated, (2) rough headcount, (3) where they're based / destination ideas if the type is trip. Do not end with "let me know if you need anything!" — ask for the specific input.\n\n4. Group thread offer: When a trip/bachelorette/reunion project is being discussed in a 1:1 thread and context shows no group thread has been created yet, include a one-time offer to start a group thread so the whole crew can be involved directly. Only offer this once — if context shows it was already offered or declined, skip it.`,
  },
] as const;

/**
 * Seeds the `agent_rules` table with the built-in policy rules if it is empty.
 * Called once at server startup. Safe to run repeatedly — it is a no-op when
 * rows already exist.
 */
export async function seedAgentRules(): Promise<void> {
  try {
    const existing = await db.$count(agentRulesTable);
    if (existing > 0) return;

    await db.insert(agentRulesTable).values(
      BUILT_IN_RULES.map((r) => ({
        name: r.name,
        category: r.category,
        sortOrder: r.sortOrder,
        content: r.content,
        enabled: true,
        isBuiltIn: true,
      })),
    );

    logger.info({ count: BUILT_IN_RULES.length }, "Seeded built-in agent rules");
  } catch (err) {
    logger.error({ err }, "Failed to seed agent rules — rules will not be injected until the table is populated");
  }
}
