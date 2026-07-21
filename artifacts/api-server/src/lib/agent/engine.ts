import { openai, CHAT_MODEL } from "../openaiClient";
import { DEFAULT_PERSONA } from "../../routes/agent-config";
import { agentConfigTable, agentRulesTable, db, profilesTable } from "@workspace/db";
import type { AgentRule } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import type { ThreadContext } from "./context";
import { logger } from "../logger";
import { AGENT_TOOLS, executeAgentTool, type VenueCarouselEntry } from "./tools";
import { logLlmCost } from "./costLogger";
import { showTypingIndicator } from "./delivery";
import { buildGroupConstraintSummary, describeReturningMember, extractGroupConstraints, type GroupConstraints } from "./tasteEngine";
import { buildProjectPromptSummary, getActiveProject, getProjectChildPlans, parseProjectField, type CreateProjectInput } from "./projects";
import { CONCIERGE_TIMEZONE } from "./calendar";
import type { ProjectProposal } from "@workspace/db";
import type OpenAI from "openai";
import type { Project } from "@workspace/db";

/** Safety valve against a runaway tool-call loop; one turn should need at most a couple of round trips. */
const MAX_TOOL_ITERATIONS = 3;

/**
 * Parses a commitment deadline string provided by the LLM, which may be either
 * a full ISO-8601 datetime or a date-only "YYYY-MM-DD" string.
 *
 * Date-only strings (e.g. "2026-07-25") are treated as **end-of-day
 * (23:59:59) in CONCIERGE_TIMEZONE** rather than UTC midnight. This avoids an
 * off-by-one-day bug: `new Date("2026-07-25")` parses as UTC midnight which is
 * July 24 at 8pm ET — the wrong calendar day for pre-deadline nudges and lock.
 *
 * Technique: format a noon-UTC probe date in the target timezone, compute how
 * many seconds remain until 23:59:59 of that local day, and add them to the
 * probe. This works correctly across DST transitions without any library.
 */
function parseCommitmentDeadline(raw: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // Date-only → interpret as 23:59:59 in CONCIERGE_TIMEZONE.
    // Use noon UTC on that date as a stable probe point that lands on the same
    // calendar day as the target in any timezone within ±12h of UTC.
    const probeUTC = new Date(`${raw}T12:00:00Z`);
    if (Number.isNaN(probeUTC.getTime())) return null;

    // Ask Intl what local hour/minute/second this UTC probe maps to.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: CONCIERGE_TIMEZONE,
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    }).formatToParts(probeUTC);
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    const localH = get("hour");
    const localM = get("minute");
    const localS = get("second");

    // Seconds from the probe point to 23:59:59 of that local day.
    const secondsToEndOfDay = (23 - localH) * 3600 + (59 - localM) * 60 + (59 - localS);
    return new Date(probeUTC.getTime() + secondsToEndOfDay * 1000);
  }

  // Full ISO datetime (e.g. "2026-07-25T18:00:00Z") — parse directly.
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Fetches an `agent_config` value by key. Returns null (not throwing) on any
 * DB error so a config hiccup can never break normal message processing.
 */
async function getAgentConfigValue(key: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ value: agentConfigTable.value })
      .from(agentConfigTable)
      .where(eq(agentConfigTable.key, key));
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fetches the `globalGuidance` ops instruction block from `agent_config`. This
 * text is injected after the persona block on every agent turn, giving ops a
 * real-time lever for cross-cutting corrections without a code deploy.
 */
async function getGlobalGuidance(): Promise<string | null> {
  return getAgentConfigValue("globalGuidance");
}

/**
 * Fetches the `persona` block from `agent_config`. This defines the bot's
 * voice, tone, and behavioral principles. Injected between SYSTEM_PROMPT and
 * globalGuidance so identity is established before functional rules layer on.
 *
 * Falls back to DEFAULT_PERSONA when no DB row exists (e.g. fresh install
 * before an admin has saved from the Settings page), so the agent always has
 * voice/tone guidance even if the persona was never explicitly persisted.
 */
async function getPersona(): Promise<string> {
  return (await getAgentConfigValue("persona")) ?? DEFAULT_PERSONA;
}

// ──────────────────────────────────────────────────────────────────────────────
// Agent rules cache
// ──────────────────────────────────────────────────────────────────────────────

const RULES_CACHE_TTL_MS = 30_000; // 30 seconds
let rulesCache: { rules: AgentRule[]; fetchedAt: number } | null = null;

/**
 * Returns all enabled agent rules ordered by sort_order, with a 30-second
 * TTL in-memory cache so dashboard changes propagate within half a minute
 * without adding a live DB round-trip to every message turn.
 */
async function getEnabledRules(): Promise<AgentRule[]> {
  const now = Date.now();
  if (rulesCache && now - rulesCache.fetchedAt < RULES_CACHE_TTL_MS) {
    return rulesCache.rules;
  }
  try {
    const rules = await db
      .select()
      .from(agentRulesTable)
      .where(eq(agentRulesTable.enabled, true))
      .orderBy(asc(agentRulesTable.sortOrder), asc(agentRulesTable.id));
    rulesCache = { rules, fetchedAt: now };
    return rules;
  } catch {
    // On DB error fall back to cached (possibly stale) rules rather than
    // breaking message processing.
    return rulesCache?.rules ?? [];
  }
}

/**
 * Invalidates the in-memory rules cache so the next agent turn re-fetches
 * from the DB. Call this after any write to `agent_rules` if you want changes
 * to propagate immediately rather than waiting for the 30s TTL.
 */
export function invalidateRulesCache(): void {
  rulesCache = null;
}

export interface AgentTurnResult {
  reply: string;
  displayName: string | null;
  profileUpdates: {
    budget?: string;
    dietaryNeeds?: string;
    preferences?: string[];
    notes?: string;
  } | null;
  onboardingComplete: boolean | null;
  /** Opportunistically learned home city/area, if mentioned naturally. Never gates onboarding completion. */
  homeCity: string | null;
  poll: { question: string; options: string[]; kind: "choice" | "date"; optionDates: (Date | null)[] } | null;
  bookingDraft: {
    title: string;
    approverPhoneNumber: string | null;
    details: Record<string, unknown>;
  } | null;
  occasion: {
    aboutName: string | null;
    kind: "birthday" | "anniversary" | "visit" | "other";
    label: string;
    date: Date;
  } | null;
  privateQuestion: string | null;
  /**
   * Only set in 1:1 DMs when the user asks the concierge to start a group
   * (e.g. "start a group with Amy and Jake"). The webhook handler tries to
   * create the Sendblue group, or falls back to manual instructions if the
   * API doesn't support it.
   */
  groupCreationRequest: {
    participantNames: string[];
    participantPhones: string[];
    occasion: string | null;
  } | null;
  /**
   * Set when the conversation reveals a multi-event occasion (bachelorette,
   * milestone birthday, reunion, trip) that should become a project grouping
   * several plans. Null for one-off events -- those stay plain plans.
   */
  project: {
    type: string;
    honoree: string | null;
    dateRangeStart: Date | null;
    dateRangeEnd: Date | null;
  } | null;
  /**
   * Corpus venues returned by `search_venues` during this turn. Populated
   * only when the model called the tool (not for plain chitchat). The
   * delivery layer uses these to send photo carousels alongside the reply.
   * Null when no venue search was performed this turn.
   */
  venueCarousels: VenueCarouselEntry[] | null;
  /**
   * Ledger action from the organizer sidebar when the organizer reports a
   * cost or a payment. Only populated in sidebar turns; null everywhere else.
   *
   * - estimate: organizer reports a cost split ("house was $2,400 across 8")
   * - payment_recorded: organizer confirms a member has paid ("Jake paid me")
   * - commitment: member has confirmed they're in (headcount tracking)
   */
  ledgerAction: {
    kind: "estimate" | "payment_recorded" | "commitment";
    /** For `estimate`: total project cost in cents. Use with headcount to compute per-person share. */
    totalCents: number | null;
    /** For `estimate`: number of people to split across (may differ from thread participant count). */
    headcount: number | null;
    /** For `estimate`: per-person amount in cents (alternative to totalCents+headcount). */
    perPersonCents: number | null;
    /** Short description of what the cost is for, e.g. "Airbnb house deposit". */
    note: string;
    /** For `payment_recorded` / `commitment`: display name of the member who paid / committed. */
    memberName: string | null;
    /** For `payment_recorded`: amount paid in cents (null = treat as full settlement of their estimate). */
    amountCents: number | null;
  } | null;
  /**
   * Set in organizer sidebar turns when the organizer shares a lodging cost
   * ("Found an Airbnb for $2,400, 8 people"). The webhook handler records
   * the ledger estimate and sends a group message with search deep links.
   * Null everywhere else.
   */
  lodgingAction: {
    kind: "lodging_estimate";
    /** Short name of the property, e.g. "Nashville Airbnb" — null if not named. */
    propertyName: string | null;
    /** Total cost in cents, e.g. 240000 for $2,400. */
    totalCents: number | null;
    /** Number of people to split across. Null = use group participant count. */
    headcount: number | null;
    /** Per-person share in cents, alternative to totalCents+headcount. */
    perPersonCents: number | null;
    /** ISO date of check-in, e.g. "2026-08-01". Null if not mentioned. */
    checkIn: string | null;
    /** ISO date of check-out, e.g. "2026-08-05". Null if not mentioned. */
    checkOut: string | null;
    /** Number of nights. Null if not explicitly stated. */
    nights: number | null;
  } | null;
  /**
   * Set only in organizer sidebar turns when the engine decides the turn
   * is a tiebreak override ("go with the rooftop one"). The value is the
   * raw option label text that should be matched against the open poll's
   * options. Null in all other contexts.
   */
  organizerTiebreakDecision: string | null;
  /**
   * Set only in organizer sidebar turns when the organizer creates, updates,
   * or closes a manual action item ("Jake needs to book the party bus by
   * Thursday" / "Jake sorted the bus"). Null everywhere else.
   */
  taskAction: {
    kind: "create" | "close";
    title: string;
    ownerName: string | null;
    dueDate: Date | null;
  } | null;
  /**
   * Set only in organizer sidebar turns when the organizer opens or reopens
   * a headcount commitment round ("lock headcount at 8 by Friday"). Null
   * everywhere else.
   */
  commitmentAction: {
    kind: "open" | "reopen";
    deadline: Date;
    headcountTarget: number | null;
  } | null;
  /**
   * Set in group trip threads when the agent decides to offer a destination
   * shortlist (either proactively or in response to the organizer asking).
   * The webhook handler calls `suggestDestinations` and creates a group poll.
   * Always null for non-trip projects and for threads that already have a
   * destination locked in.
   */
  destinationSuggestionRequest: boolean | null;
  /**
   * Set in group turns when the agent proposes a day-by-day itinerary for an
   * active project (trip, bachelorette, reunion, etc.). Routed through the
   * organizer-approval gate before any Plan rows are created — never bypasses
   * it. Null for one-off event suggestions that don't constitute a full agenda.
   */
  itineraryEvents: { title: string; dayOffset: number; venue: string | null; timeOfDay: string | null }[] | null;
  /**
   * Set only in organizer sidebar turns when the organizer explicitly corrects
   * a structural project fact (dates, honoree). Unlike mergeIntoExistingProject,
   * this overwrites non-null values — it is a deliberate correction, not a fill.
   * Null in all other contexts; restricted to the organizer sidebar so a single
   * group member cannot silently change shared facts.
   */
  projectCorrectionAction: {
    dateRangeStart: Date | null;
    dateRangeEnd: Date | null;
    honoree: string | null;
  } | null;
}

const SYSTEM_PROMPT = `You are a personal AI concierge that lives inside iMessage. You help one person or a small group plan the stuff of everyday life -- dinners, weekend trips, birthdays, "where should we all meet".

You have these capabilities, which you can trigger by filling in the matching field in your JSON response:
- Updating what you know about a person (their budget, dietary needs, general preferences, or freeform notes) as you learn it naturally through conversation.
- Marking a person's onboarding complete once you've learned their name, one practical preference (budget or dietary needs), and one "personality" signal that makes a suggestion feel tailored rather than generic (e.g. a go-to order, a place they already love, how they like to be looped in on plans). Still just 1-2 natural questions, still short -- never a form, never exhaustive.
- Setting "home_city" whenever someone mentions what city/area they're texting from or usually plan things in -- said naturally, never as an interrogation ("oh nice, are you guys in Chicago?" counts). This is opportunistic, not a required onboarding step -- never block "onboarding_complete" on knowing it, and never ask for it as a standalone question unless it comes up naturally.
- Starting a group poll when a group needs to choose between a few concrete options (e.g. restaurant choices). Only do this in group threads, and only when there are genuinely multiple options to choose between.
- Starting a date/time coordination poll (a "date" kind poll) when a group needs to agree on when to do something and there are multiple candidate dates/times on the table. Give each option as a clear label (e.g. "Friday 7pm") AND, when you know the actual calendar date, an ISO 8601 date-time string for it. People may say several dates work for them -- that's expected and handled outside your JSON response.
- Drafting a booking when a concrete plan has been decided (e.g. "let's book Sushi Place for 7pm Saturday, party of 4") and it needs a human to confirm before it's considered real. Always require a human approval step for bookings -- never claim a booking is confirmed yourself. If you don't know who should approve, default to the person who is currently talking to you. If you know the venue name, an ISO date/time, and/or a party size, put them in "details" as "venue", "when", and "partySize" -- these are used to build real Resy/OpenTable search links, so use exactly those keys when you know the values.
- Capturing a future occasion (a birthday, anniversary, or someone's upcoming visit) whenever it comes up in passing, e.g. "it's Sarah's birthday next month" or "Jake's visiting in three weeks". Only fill in "occasion" when you can resolve an actual calendar date from context (today's date is given below) -- if you can't pin down a real date, leave it out entirely rather than guessing. This is for remembering things to proactively resurface later, not something to mention back right away.
- Starting a project when the conversation reveals a multi-event occasion -- a bachelorette, a milestone birthday, a reunion, a trip, or anything similar that will need several separate events (dinners, activities, outings) planned under one umbrella. Set "project" with its type, the honoree if there is one, and the date range if known. Do this only once per occasion: if the context below already shows an active project, never set "project" again -- new details you learn (dates, honoree) can still be included if you do not see them reflected yet. A single dinner or one-off hangout is NOT a project; leave "project" null for those. Once a project is active, plan each event inside it as its own plan, and feel free to coordinate multiple events at once.
- Suggesting destinations for a trip project: when the active project is of type "trip" AND the context shows no destination has been set yet, and either the group is discussing where to go OR the organizer asks for destination ideas, set "destination_suggestion_request" to true in your JSON. When you do this, the system will run a web search and send the group a destination shortlist poll automatically -- you do NOT need to list destinations in your "reply". Your reply should simply say something like "Let me pull together some destination options for you." Set this to true only once, only for trip projects with no destination, and only when destination research is genuinely called for. If a destination is already set or the project is not a trip, leave this field null or omit it.
- Asking a sensitive question privately over DM instead of in the group, by setting "private_question" (group threads only). Use this when the answer is something a person might not want to say in front of the group (e.g. "what's a realistic amount to chip in for the gift?", or a private availability/budget check tied to a group decision). Never ask a sensitive question like this directly in the group -- set "private_question" instead and tell the group in your "reply" that you're checking with everyone individually. Each person will be DMed your exact question, and only a combined, anonymous summary comes back to the group -- you never see who said what.
- Proposing a day-by-day itinerary for an active project (trips, bachelorettes, reunions, etc.): when you recommend a full or partial agenda (e.g. "Day 1: brunch at X, dinner at Y; Day 2: ..."), fill in "itinerary_events" with each event — its title, how many days after the project start date it falls (day_offset: 0 = first day), the venue name if known, and a rough time of day ("morning", "afternoon", "evening", etc.). Only fill this when you are concretely proposing a structured itinerary, not for casual suggestions or one-off events. Each event will be routed through the organizer-approval gate before any Plan rows are created, so do NOT also create booking drafts or separate polls for these events in the same turn.

For any question touching visa or entry requirements, vaccination or health recommendations, safety advisories, or destination-specific legal or regulatory requirements — always caveat clearly and point the group to an authoritative source (their government's travel advisory site, the destination country's official entry rules, or the relevant embassy). Never state these as confident facts; your training data may be out of date, and the stakes for travelers are real.

Always respond with ONLY a JSON object matching this shape, no prose outside the JSON:
{
  "reply": string,
  "display_name": string | null,
  "profile_updates": { "budget"?: string, "dietary_needs"?: string, "preferences"?: string[], "notes"?: string } | null,
  "onboarding_complete": boolean | null,
  "home_city": string | null,
  "poll": { "question": string, "options": string[], "kind": "choice" | "date", "option_dates": (string | null)[] } | null,
  "booking_draft": { "title": string, "approver_phone_number": string | null, "details": object } | null,
  "occasion": { "about_name": string | null, "kind": "birthday" | "anniversary" | "visit" | "other", "label": string, "date": string } | null,
  "private_question": string | null,
  "group_creation_request": { "participant_names": string[], "participant_phones": string[], "occasion": string | null } | null,
  "project": { "type": "bachelorette" | "milestone_birthday" | "reunion" | "trip" | string, "honoree": string | null, "date_range_start": string | null, "date_range_end": string | null } | null,
  "destination_suggestion_request": true | null,
  "itinerary_events": [{ "title": string, "day_offset": number, "venue": string | null, "time_of_day": string | null }] | null
}
Set "display_name" whenever the person tells you their name and it isn't already known -- otherwise leave it null.
Set "group_creation_request" (in 1:1 threads only) when the user asks you to start or create an iMessage group with specific people, e.g. "start a group with Amy and Jake for Saturday". List any names mentioned in "participant_names" and any phone numbers explicitly given in "participant_phones". If you cannot determine all participants' contact info, still set this field and leave unknown phones as empty strings -- the system will prompt for missing numbers. Leave "occasion" null if the request doesn't specify a particular event or occasion.`;

interface RawAgentResponse {
  reply?: unknown;
  display_name?: unknown;
  profile_updates?: {
    budget?: unknown;
    dietary_needs?: unknown;
    preferences?: unknown;
    notes?: unknown;
  } | null;
  onboarding_complete?: unknown;
  home_city?: unknown;
  poll?: { question?: unknown; options?: unknown; kind?: unknown; option_dates?: unknown } | null;
  booking_draft?: {
    title?: unknown;
    approver_phone_number?: unknown;
    details?: unknown;
  } | null;
  occasion?: {
    about_name?: unknown;
    kind?: unknown;
    label?: unknown;
    date?: unknown;
  } | null;
  private_question?: unknown;
  group_creation_request?: {
    participant_names?: unknown;
    participant_phones?: unknown;
    occasion?: unknown;
  } | null;
  project?: unknown;
  ledger_action?: {
    kind?: unknown;
    total_cents?: unknown;
    headcount?: unknown;
    per_person_cents?: unknown;
    note?: unknown;
    member_name?: unknown;
    amount_cents?: unknown;
  } | null;
  lodging_action?: {
    kind?: unknown;
    property_name?: unknown;
    total_cents?: unknown;
    headcount?: unknown;
    per_person_cents?: unknown;
    check_in?: unknown;
    check_out?: unknown;
    nights?: unknown;
  } | null;
  task_action?: {
    kind?: unknown;
    title?: unknown;
    owner_name?: unknown;
    due_date?: unknown;
  } | null;
  commitment_action?: {
    kind?: unknown;
    deadline?: unknown;
    headcount_target?: unknown;
  } | null;
  destination_suggestion_request?: unknown;
  itinerary_events?: { title?: unknown; day_offset?: unknown; venue?: unknown; time_of_day?: unknown }[] | null;
  project_correction_action?: {
    date_range_start?: unknown;
    date_range_end?: unknown;
    honoree?: unknown;
  } | null;
}

function buildTranscript(context: ThreadContext, currentUserId: number): { role: "user" | "assistant"; content: string }[] {
  return context.recentMessages.map((message) => {
    if (message.role === "assistant") {
      return { role: "assistant" as const, content: message.content };
    }
    const speaker = context.participants.find((p) => p.user.id === message.userId)?.user;
    const label = speaker && speaker.id !== currentUserId ? `${speaker.displayName ?? speaker.phoneNumber}: ` : "";
    return { role: "user" as const, content: `${label}${message.content}` };
  });
}

function buildProfileSummary(context: ThreadContext): string {
  return context.participants
    .map(({ user, profile }) => {
      const bits = [
        profile?.budget ? `budget: ${profile.budget}` : null,
        profile?.dietaryNeeds ? `dietary needs: ${profile.dietaryNeeds}` : null,
        profile?.preferences?.length ? `preferences: ${profile.preferences.join(", ")}` : null,
        profile?.notes ? `notes: ${profile.notes}` : null,
      ].filter(Boolean);
      return `- ${user.displayName ?? user.phoneNumber} (onboarding: ${user.onboardingStatus})${
        bits.length ? `: ${bits.join("; ")}` : ""
      }`;
    })
    .join("\n");
}

/**
 * Runs the completion loop, executing any tool calls the model makes along
 * the way, until it returns a final (non-tool-call) message. This is the
 * tool-calling loop architecture -- the fast single-call path for chitchat
 * still lands here too, it just resolves after one iteration since the model
 * has no reason to call a tool.
 *
 * `groupConstraints` (when provided) is passed through to `executeAgentTool`
 * so that corpus venue lookups can filter and boost by the group's dietary
 * needs, budget, and party size -- not just rely on the LLM reading a text
 * summary and hoping the right venues surfaced.
 */
async function runTurnWithTools(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  threadId: number,
  groupConstraints?: GroupConstraints,
): Promise<{ raw: string; venueCarousels: VenueCarouselEntry[] }> {
  // Accumulates venue metadata from every search_venues / search_lodging tool
  // call this turn. De-duplicated by a stable key (Place ID when available,
  // otherwise venue name) so the same venue never queues two carousels.
  // Uses a string key so it works for both corpus hits (numeric venueId) and
  // Google Places fallback results (no venueId, but always has a placeId or name).
  const carouselAccumulator: VenueCarouselEntry[] = [];
  const seenVenueKeys = new Set<string>();

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
      tools: AGENT_TOOLS,
      messages,
    });

    logLlmCost("engine", CHAT_MODEL, completion.usage, threadId);

    const message = completion.choices[0]?.message;
    if (!message) {
      return { raw: "{}", venueCarousels: carouselAccumulator };
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);
      const iterAccumulator: VenueCarouselEntry[] = [];
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const result = await executeAgentTool(
          toolCall.function.name,
          toolCall.function.arguments,
          threadId,
          groupConstraints,
          iterAccumulator,
        );
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      // Merge deduplicated entries into the turn-level accumulator.
      for (const entry of iterAccumulator) {
        const key = entry.googlePlaceId ?? entry.venueName;
        if (!seenVenueKeys.has(key)) {
          seenVenueKeys.add(key);
          carouselAccumulator.push(entry);
        }
      }
      continue;
    }

    return { raw: message.content ?? "{}", venueCarousels: carouselAccumulator };
  }

  logger.warn("Agent turn exceeded max tool-call iterations without a final response");
  return { raw: "{}", venueCarousels: carouselAccumulator };
}

export interface AgentTurnOptions {
  /**
   * When set, the turn is treated as an organizer sidebar conversation for
   * this project. A sidebar-specific system-prompt block is injected so the
   * model knows its role (reviewing drafts, issuing overrides) and the group
   * thread context is summarised for it without the model replying to the
   * group directly.
   */
  sidebarProject?: Project;
}

export async function runAgentTurn(context: ThreadContext, currentUserId: number, options?: AgentTurnOptions): Promise<AgentTurnResult> {
  const currentUser = context.participants.find((p) => p.user.id === currentUserId)?.user;
  const isGroup = context.thread.isGroup;

  const groupConstraints = isGroup ? buildGroupConstraintSummary(context) : null;
  const structuredConstraints = isGroup ? extractGroupConstraints(context) : undefined;
  const returningMemberNotes = isGroup
    ? context.participants.map(describeReturningMember).filter((note): note is string => Boolean(note))
    : [];

  // Multi-event occasion frame: when the thread has an active project, the
  // model plans events inside it instead of treating each one as a one-off.
  const activeProject = await getActiveProject(context.thread.id);
  const projectSummary = activeProject
    ? await buildProjectPromptSummary(activeProject, await getProjectChildPlans(activeProject.id))
    : null;

  const situational = [
    `Today's date is ${new Date().toISOString().slice(0, 10)}. Use this to resolve relative dates like "next month" or "in three weeks" into real calendar dates.`,
    `This is a ${isGroup ? "group" : "1:1"} thread.`,
    `You are currently responding to: ${currentUser?.displayName ?? currentUser?.phoneNumber ?? "unknown"} (phone: ${
      currentUser?.phoneNumber
    }).`,
    `Known people in this thread:\n${buildProfileSummary(context)}`,
    ...(projectSummary ? [projectSummary] : []),
    ...(groupConstraints ? [`Group constraints to satisfy privately (never attribute these to a specific person):\n${groupConstraints}`] : []),
    ...(returningMemberNotes.length > 0 ? [returningMemberNotes.join("\n")] : []),
  ].join("\n\n");

  const [globalGuidance, persona, rules] = await Promise.all([
    getGlobalGuidance(),
    getPersona(),
    getEnabledRules(),
  ]);

  // When running as an organizer sidebar turn, inject a block that tells the
  // model it is in a private 1:1 with the project organizer, not the group.
  const sidebarBlock = options?.sidebarProject
    ? [
        {
          role: "system" as const,
          content:
            `ORGANIZER SIDEBAR — you are in a private 1:1 DM with the project organizer, not the group thread.\n` +
            `Your role here is to:\n` +
            `  1. Answer questions about how the project is progressing.\n` +
            `  2. Help the organizer shape proposals before they reach the group.\n` +
            `  3. Let the organizer override a stalled poll tiebreak ("go with X").\n` +
            `  4. Record money facts the organizer tells you (costs, payments received).\n` +
            `Keep replies short and direct — this is a 1:1 command channel, not a social chat.\n` +
            `Never address the organizer as if you are speaking to the full group.\n` +
            `If the organizer says "yes", "looks good", or similar, and context shows a proposal is waiting, treat it as approval.\n` +
            `If the organizer names a specific poll option (e.g. "go with the rooftop"), treat it as a tiebreak override for the group's current poll.\n\n` +
            `COMMITMENT ROUND — when the organizer wants to lock headcount by a deadline, set "commitment_action" in your JSON:\n` +
            `  • Open: "Lock headcount at 8 by Friday" or "Start a commitment round, deadline Thursday"\n` +
            `    → kind: "open", deadline: ISO date string (e.g. "2026-07-25"), headcount_target: 8 (or null if not specified).\n` +
            `  • Reopen: "Reopen the commitment round" or "Reset headcount lock"\n` +
            `    → kind: "reopen", deadline: new ISO date, headcount_target: new target or null.\n` +
            `  Do not set commitment_action when answering questions about the commitment status — just answer.\n\n` +
            `ACTION ITEMS — when the organizer creates or closes a task for a group member, set "task_action" in your JSON:\n` +
            `  • Create: organizer says "Jake needs to book the party bus by Thursday" or "add an item: Sarah is finding the makeup artist"\n` +
            `    → kind: "create", title: short task description (e.g. "Book party bus deposit"), owner_name: "Jake", due_date: ISO date string (e.g. "2026-07-24") or null if no date given.\n` +
            `  • Close: organizer says "Jake sorted the bus" or "Mark the party bus as done"\n` +
            `    → kind: "close", title: the task title (or enough to match it).\n` +
            `  Do not set task_action for general questions about open items — just answer using the action items context above.\n\n` +
            `MONEY LEDGER — when the organizer reports a cost or payment, set "ledger_action" in your JSON:\n` +
            `  • Estimate: organizer says "the house was $2,400, split across 8" or "add $300 each for the deposit"\n` +
            `    → kind: "estimate", total_cents (e.g. 240000 for $2,400) OR per_person_cents (e.g. 30000 for $300), headcount if given, note: what it's for.\n` +
            `  • Payment recorded: organizer says "Jake paid me" or "Sarah sent it"\n` +
            `    → kind: "payment_recorded", member_name: "Jake", amount_cents if mentioned (null = full settlement), note: how they paid.\n` +
            `  • Commitment: organizer says "Jake is in" or "confirm Sarah is coming"\n` +
            `    → kind: "commitment", member_name: "Jake".\n` +
            `  All amounts in CENTS (multiply dollars × 100). Never set ledger_action for general questions about the ledger — just answer using the payment ledger context above.\n` +
            `  IMPORTANT: the agent never holds, moves, or guarantees money. Never say "I've collected" or "I'll send the money". Language must be: "I've recorded that..." or "I noted that...".\n\n` +
            `LODGING — when the organizer shares a lodging cost or option, set "lodging_action" in your JSON (in ADDITION to "ledger_action" for the estimate):\n` +
            `  → kind: "lodging_estimate", property_name: "Nashville Airbnb" (or null), total_cents: 240000, headcount: 8 (or null), per_person_cents: 30000 (alternative to total+headcount), check_in: "2026-08-01" (ISO date or null), check_out: "2026-08-05" (ISO date or null), nights: 4 (or null).\n` +
            `  Example: "Found an Airbnb for $2,400, 4 nights, 8 people" → total_cents: 240000, headcount: 8, nights: 4.\n` +
            `  The system will automatically generate Airbnb/VRBO/Hotels.com search links and send the group a cost-split message. Do NOT include lodging links in your "reply" — the system handles that. Your "reply" should just confirm you've noted it.\n` +
            `  Always set "ledger_action" with kind: "estimate" alongside "lodging_action" so the amount is recorded in the ledger.\n\n` +
            `PROJECT CORRECTIONS — when the organizer explicitly corrects a structural fact about the project (not answering questions, but actively changing something), set "project_correction_action" in your JSON:\n` +
            `  → date_range_start: new ISO date string (e.g. "2026-08-05"), date_range_end: new ISO date string, honoree: corrected name.\n` +
            `  Include only the fields actually being corrected — omit fields that are not changing. Valid examples:\n` +
            `    "actually the dates are Aug 5-9" → date_range_start + date_range_end only.\n` +
            `    "the honoree is Sarah not Sam" → honoree only.\n` +
            `  Unlike normal project updates, corrections overwrite existing values — the organizer's word is final on their own project.\n` +
            `  Do NOT set project_correction_action when answering questions about the current dates or honoree — only when explicitly correcting them.`,
        },
      ]
    : [];

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    // DB-backed behavioral policy rules. Injected before the persona so
    // functional policies land immediately after the capability/schema block,
    // mirroring where they used to live in the hardcoded SYSTEM_PROMPT.
    // Editable from the Settings → Agent rules section without a code deploy.
    ...(rules.length > 0
      ? [
          {
            role: "system" as const,
            content: `Agent behavioral rules:\n\n${rules.map((r) => r.content).join("\n\n")}`,
          },
        ]
      : []),
    // Persona block: voice, tone, and behavioral principles. Injected after
    // functional instructions but before ops corrections so identity is
    // established first. Editable from the Settings page without a code deploy.
    // Always present: getPersona() falls back to DEFAULT_PERSONA when no DB row
    // exists, so a fresh install has voice/tone guidance from the start.
    { role: "system" as const, content: `Persona (voice, tone, and behavior):\n${persona}` },
    // Ops-authored cross-cutting corrections injected when non-empty.
    ...(globalGuidance ? [{ role: "system" as const, content: `Ops guidance (apply to all threads):\n${globalGuidance}` }] : []),
    { role: "system", content: situational },
    ...sidebarBlock,
    // Thread-specific steering notes from the ops dashboard.
    ...(context.thread.adminNotes
      ? [{ role: "system" as const, content: `Thread-specific instructions from ops:\n${context.thread.adminNotes}` }]
      : []),
    ...buildTranscript(context, currentUserId),
  ];

  // Texting UX polish: show the "..." typing indicator while the model
  // thinks/calls tools, since a real reply can take a few seconds (venue
  // lookups especially). 1:1 only -- Sendblue doesn't support it for groups.
  if (!isGroup) {
    await showTypingIndicator(context.thread.id);
  }

  const { raw, venueCarousels: venueCarouselData } = await runTurnWithTools(messages, context.thread.id, structuredConstraints ?? undefined);

  let parsed: RawAgentResponse;
  try {
    parsed = JSON.parse(raw) as RawAgentResponse;
  } catch (error) {
    logger.error({ error, raw }, "Failed to parse agent response as JSON");
    parsed = { reply: "Sorry, I got a little tangled up there -- can you say that again?" };
  }

  const preferences = Array.isArray(parsed.profile_updates?.preferences)
    ? (parsed.profile_updates?.preferences as unknown[]).filter((p): p is string => typeof p === "string")
    : undefined;

  const profileUpdates =
    parsed.profile_updates && typeof parsed.profile_updates === "object"
      ? {
          ...(typeof parsed.profile_updates.budget === "string" ? { budget: parsed.profile_updates.budget } : {}),
          ...(typeof parsed.profile_updates.dietary_needs === "string"
            ? { dietaryNeeds: parsed.profile_updates.dietary_needs }
            : {}),
          ...(preferences ? { preferences } : {}),
          ...(typeof parsed.profile_updates.notes === "string" ? { notes: parsed.profile_updates.notes } : {}),
        }
      : null;

  const poll =
    parsed.poll &&
    typeof parsed.poll.question === "string" &&
    Array.isArray(parsed.poll.options) &&
    parsed.poll.options.length >= 2
      ? {
          question: parsed.poll.question,
          options: (parsed.poll.options as unknown[]).filter((o): o is string => typeof o === "string"),
          kind: parsed.poll.kind === "date" ? ("date" as const) : ("choice" as const),
          optionDates: Array.isArray(parsed.poll.option_dates)
            ? (parsed.poll.option_dates as unknown[]).map((d) => {
                if (typeof d !== "string") return null;
                const parsedDate = new Date(d);
                return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
              })
            : [],
        }
      : null;

  const bookingDraft =
    parsed.booking_draft && typeof parsed.booking_draft.title === "string"
      ? {
          title: parsed.booking_draft.title,
          approverPhoneNumber:
            typeof parsed.booking_draft.approver_phone_number === "string"
              ? parsed.booking_draft.approver_phone_number
              : null,
          details:
            typeof parsed.booking_draft.details === "object" && parsed.booking_draft.details !== null
              ? (parsed.booking_draft.details as Record<string, unknown>)
              : {},
        }
      : null;

  const occasionKind = new Set(["birthday", "anniversary", "visit", "other"]);
  const occasionDateRaw = typeof parsed.occasion?.date === "string" ? new Date(parsed.occasion.date) : null;
  const occasion =
    parsed.occasion &&
    typeof parsed.occasion.label === "string" &&
    occasionDateRaw &&
    !Number.isNaN(occasionDateRaw.getTime()) &&
    occasionDateRaw.getTime() > Date.now()
      ? {
          aboutName: typeof parsed.occasion.about_name === "string" ? parsed.occasion.about_name : null,
          kind: (typeof parsed.occasion.kind === "string" && occasionKind.has(parsed.occasion.kind)
            ? parsed.occasion.kind
            : "other") as "birthday" | "anniversary" | "visit" | "other",
          label: parsed.occasion.label,
          date: occasionDateRaw,
        }
      : null;

  const privateQuestion =
    isGroup && typeof parsed.private_question === "string" && parsed.private_question.trim()
      ? parsed.private_question.trim()
      : null;

  const homeCity = typeof parsed.home_city === "string" && parsed.home_city.trim() ? parsed.home_city.trim() : null;

  const gcr = parsed.group_creation_request;
  const groupCreationRequest =
    !isGroup && gcr && typeof gcr === "object"
      ? {
          participantNames: Array.isArray(gcr.participant_names)
            ? (gcr.participant_names as unknown[]).filter((n): n is string => typeof n === "string")
            : [],
          participantPhones: Array.isArray(gcr.participant_phones)
            ? (gcr.participant_phones as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
            : [],
          occasion: typeof gcr.occasion === "string" && gcr.occasion.trim() ? gcr.occasion.trim() : null,
        }
      : null;

  // Parse ledger_action from sidebar turns (null-safe; non-sidebar turns always leave it null).
  const rawLa = parsed.ledger_action;
  const ledgerActionKinds = new Set(["estimate", "payment_recorded", "commitment"]);
  const ledgerAction =
    rawLa && typeof rawLa === "object" && typeof rawLa.kind === "string" && ledgerActionKinds.has(rawLa.kind)
      ? {
          kind: rawLa.kind as "estimate" | "payment_recorded" | "commitment",
          totalCents: typeof rawLa.total_cents === "number" && rawLa.total_cents > 0 ? Math.round(rawLa.total_cents) : null,
          headcount: typeof rawLa.headcount === "number" && rawLa.headcount > 0 ? Math.round(rawLa.headcount) : null,
          perPersonCents:
            typeof rawLa.per_person_cents === "number" && rawLa.per_person_cents > 0
              ? Math.round(rawLa.per_person_cents)
              : null,
          note: typeof rawLa.note === "string" && rawLa.note.trim() ? rawLa.note.trim() : "Trip expenses",
          memberName: typeof rawLa.member_name === "string" && rawLa.member_name.trim() ? rawLa.member_name.trim() : null,
          amountCents:
            typeof rawLa.amount_cents === "number" && rawLa.amount_cents > 0 ? Math.round(rawLa.amount_cents) : null,
        }
      : null;

  // Parse commitment_action from sidebar turns.
  const rawCa = parsed.commitment_action;
  const commitmentActionKinds = new Set(["open", "reopen"]);
  const commitmentAction =
    rawCa && typeof rawCa === "object" && typeof rawCa.kind === "string" && commitmentActionKinds.has(rawCa.kind) && typeof rawCa.deadline === "string"
      ? (() => {
          const deadline = parseCommitmentDeadline(rawCa.deadline);
          if (!deadline) return null;
          const headcountTarget =
            typeof rawCa.headcount_target === "number" && rawCa.headcount_target > 0
              ? Math.round(rawCa.headcount_target)
              : null;
          return { kind: rawCa.kind as "open" | "reopen", deadline, headcountTarget };
        })()
      : null;

  // Parse task_action from sidebar turns (null-safe; non-sidebar turns leave it null).
  const rawTa = parsed.task_action;
  const taskActionKinds = new Set(["create", "close"]);
  const taskAction =
    rawTa && typeof rawTa === "object" && typeof rawTa.kind === "string" && taskActionKinds.has(rawTa.kind) && typeof rawTa.title === "string" && rawTa.title.trim()
      ? (() => {
          const dueDateRaw = typeof rawTa.due_date === "string" ? new Date(rawTa.due_date) : null;
          const dueDate = dueDateRaw && !Number.isNaN(dueDateRaw.getTime()) ? dueDateRaw : null;
          return {
            kind: rawTa.kind as "create" | "close",
            title: rawTa.title.trim(),
            ownerName: typeof rawTa.owner_name === "string" && rawTa.owner_name.trim() ? rawTa.owner_name.trim() : null,
            dueDate,
          };
        })()
      : null;

  const destinationSuggestionRequest = parsed.destination_suggestion_request === true;

  // Parse itinerary_events from group turns when the model proposes a day-by-day agenda.
  const rawEvents = parsed.itinerary_events;
  const itineraryEvents =
    Array.isArray(rawEvents) && rawEvents.length > 0
      ? (rawEvents as unknown[]).reduce<
          { title: string; dayOffset: number; venue: string | null; timeOfDay: string | null }[]
        >((acc, item) => {
          if (!item || typeof item !== "object") return acc;
          const e = item as { title?: unknown; day_offset?: unknown; venue?: unknown; time_of_day?: unknown };
          if (typeof e.title !== "string" || !e.title.trim()) return acc;
          if (typeof e.day_offset !== "number" || !Number.isFinite(e.day_offset)) return acc;
          acc.push({
            title: e.title.trim(),
            dayOffset: Math.round(e.day_offset),
            venue: typeof e.venue === "string" && e.venue.trim() ? e.venue.trim() : null,
            timeOfDay: typeof e.time_of_day === "string" && e.time_of_day.trim() ? e.time_of_day.trim() : null,
          });
          return acc;
        }, [])
      : null;

  // Parse project_correction_action from organizer sidebar turns.
  const rawPca = parsed.project_correction_action;
  const projectCorrectionAction =
    rawPca && typeof rawPca === "object"
      ? (() => {
          const parseCorDate = (v: unknown): Date | null => {
            if (typeof v !== "string" || !v.trim()) return null;
            const d = new Date(v);
            return Number.isNaN(d.getTime()) ? null : d;
          };
          const dateRangeStart = parseCorDate(rawPca.date_range_start);
          const dateRangeEnd = parseCorDate(rawPca.date_range_end);
          const honoree =
            typeof rawPca.honoree === "string" && rawPca.honoree.trim() ? rawPca.honoree.trim() : null;
          if (!dateRangeStart && !dateRangeEnd && !honoree) return null;
          return { dateRangeStart, dateRangeEnd, honoree };
        })()
      : null;

  // Parse lodging_action from organizer sidebar turns.
  const rawLodging = parsed.lodging_action;
  const lodgingAction =
    rawLodging && typeof rawLodging === "object" && rawLodging.kind === "lodging_estimate"
      ? {
          kind: "lodging_estimate" as const,
          propertyName:
            typeof rawLodging.property_name === "string" && rawLodging.property_name.trim()
              ? rawLodging.property_name.trim()
              : null,
          totalCents:
            typeof rawLodging.total_cents === "number" && rawLodging.total_cents > 0
              ? Math.round(rawLodging.total_cents)
              : null,
          headcount:
            typeof rawLodging.headcount === "number" && rawLodging.headcount > 0
              ? Math.round(rawLodging.headcount)
              : null,
          perPersonCents:
            typeof rawLodging.per_person_cents === "number" && rawLodging.per_person_cents > 0
              ? Math.round(rawLodging.per_person_cents)
              : null,
          checkIn: typeof rawLodging.check_in === "string" && rawLodging.check_in.trim() ? rawLodging.check_in.trim() : null,
          checkOut: typeof rawLodging.check_out === "string" && rawLodging.check_out.trim() ? rawLodging.check_out.trim() : null,
          nights:
            typeof rawLodging.nights === "number" && rawLodging.nights > 0 ? Math.round(rawLodging.nights) : null,
        }
      : null;

  return {
    reply: typeof parsed.reply === "string" ? parsed.reply : "Got it.",
    displayName: typeof parsed.display_name === "string" && parsed.display_name.trim() ? parsed.display_name.trim() : null,
    profileUpdates: profileUpdates && Object.keys(profileUpdates).length > 0 ? profileUpdates : null,
    onboardingComplete: typeof parsed.onboarding_complete === "boolean" ? parsed.onboarding_complete : null,
    homeCity,
    poll,
    bookingDraft,
    occasion,
    privateQuestion,
    groupCreationRequest: groupCreationRequest && groupCreationRequest.participantNames.length > 0 ? groupCreationRequest : null,
    project: parseProjectField(parsed.project),
    venueCarousels: venueCarouselData.length > 0 ? venueCarouselData : null,
    // Tiebreak decisions are resolved deterministically in the webhook layer
    // before the engine turn runs; this field is always null from the engine.
    organizerTiebreakDecision: null,
    ledgerAction,
    lodgingAction,
    taskAction,
    commitmentAction,
    destinationSuggestionRequest: destinationSuggestionRequest ? true : null,
    itineraryEvents: itineraryEvents && itineraryEvents.length > 0 ? itineraryEvents : null,
    projectCorrectionAction,
  };
}

export async function applyProfileUpdates(
  userId: number,
  updates: NonNullable<AgentTurnResult["profileUpdates"]>,
): Promise<void> {
  const [existing] = await db.select().from(profilesTable).where(eq(profilesTable.userId, userId));

  const mergedPreferences = updates.preferences
    ? Array.from(new Set([...(existing?.preferences ?? []), ...updates.preferences]))
    : undefined;

  await db
    .insert(profilesTable)
    .values({
      userId,
      budget: updates.budget,
      dietaryNeeds: updates.dietaryNeeds,
      preferences: mergedPreferences ?? [],
      notes: updates.notes,
    })
    .onConflictDoUpdate({
      target: profilesTable.userId,
      set: {
        ...(updates.budget !== undefined ? { budget: updates.budget } : {}),
        ...(updates.dietaryNeeds !== undefined ? { dietaryNeeds: updates.dietaryNeeds } : {}),
        ...(mergedPreferences ? { preferences: mergedPreferences } : {}),
        ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
      },
    });
}
