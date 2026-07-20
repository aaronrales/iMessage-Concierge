import { openai, CHAT_MODEL } from "../openaiClient";
import { agentConfigTable, db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { ThreadContext } from "./context";
import { logger } from "../logger";
import { AGENT_TOOLS, executeAgentTool, type VenueCarouselEntry } from "./tools";
import { showTypingIndicator } from "./delivery";
import { buildGroupConstraintSummary, describeReturningMember, extractGroupConstraints, type GroupConstraints } from "./tasteEngine";
import { buildProjectPromptSummary, getActiveProject, getProjectChildPlans, parseProjectField, type CreateProjectInput } from "./projects";
import type { ProjectProposal } from "@workspace/db";
import type OpenAI from "openai";
import type { Project } from "@workspace/db";

/** Safety valve against a runaway tool-call loop; one turn should need at most a couple of round trips. */
const MAX_TOOL_ITERATIONS = 3;

/**
 * Fetches the `globalGuidance` ops instruction block from `agent_config`. This
 * text is prepended to every agent system prompt when non-empty, giving ops a
 * real-time lever for cross-cutting corrections without a code deploy.
 *
 * Returns null (not throwing) on any DB error so a config hiccup can never
 * break normal message processing.
 */
async function getGlobalGuidance(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ value: agentConfigTable.value })
      .from(agentConfigTable)
      .where(eq(agentConfigTable.key, "globalGuidance"));
    return row?.value?.trim() || null;
  } catch {
    return null;
  }
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
}

const SYSTEM_PROMPT = `You are a personal AI concierge that lives inside iMessage. You help one person or a small group plan the stuff of everyday life -- dinners, weekend trips, birthdays, "where should we all meet". You are warm, concise, and text like a helpful friend, not a corporate assistant. Keep replies short enough for a text message (usually under 3 sentences) and never use emojis.

You have these capabilities, which you can trigger by filling in the matching field in your JSON response:
- Updating what you know about a person (their budget, dietary needs, general preferences, or freeform notes) as you learn it naturally through conversation.
- Marking a person's onboarding complete once you've learned their name, one practical preference (budget or dietary needs), and one "personality" signal that makes a suggestion feel tailored rather than generic (e.g. a go-to order, a place they already love, how they like to be looped in on plans). Still just 1-2 natural questions, still short -- never a form, never exhaustive.
- Setting "home_city" whenever someone mentions what city/area they're texting from or usually plan things in -- said naturally, never as an interrogation ("oh nice, are you guys in Chicago?" counts). This is opportunistic, not a required onboarding step -- never block "onboarding_complete" on knowing it, and never ask for it as a standalone question unless it comes up naturally.
- Starting a group poll when a group needs to choose between a few concrete options (e.g. restaurant choices). Only do this in group threads, and only when there are genuinely multiple options to choose between.
- Starting a date/time coordination poll (a "date" kind poll) when a group needs to agree on when to do something and there are multiple candidate dates/times on the table. Give each option as a clear label (e.g. "Friday 7pm") AND, when you know the actual calendar date, an ISO 8601 date-time string for it. People may say several dates work for them -- that's expected and handled outside your JSON response.
- Drafting a booking when a concrete plan has been decided (e.g. "let's book Sushi Place for 7pm Saturday, party of 4") and it needs a human to confirm before it's considered real. Always require a human approval step for bookings -- never claim a booking is confirmed yourself. If you don't know who should approve, default to the person who is currently talking to you. If you know the venue name, an ISO date/time, and/or a party size, put them in "details" as "venue", "when", and "partySize" -- these are used to build real Resy/OpenTable search links, so use exactly those keys when you know the values.
- Capturing a future occasion (a birthday, anniversary, or someone's upcoming visit) whenever it comes up in passing, e.g. "it's Sarah's birthday next month" or "Jake's visiting in three weeks". Only fill in "occasion" when you can resolve an actual calendar date from context (today's date is given below) -- if you can't pin down a real date, leave it out entirely rather than guessing. This is for remembering things to proactively resurface later, not something to mention back right away.
- Starting a project when the conversation reveals a multi-event occasion -- a bachelorette, a milestone birthday, a reunion, a trip, or anything similar that will need several separate events (dinners, activities, outings) planned under one umbrella. Set "project" with its type, the honoree if there is one, and the date range if known. Do this only once per occasion: if the context below already shows an active project, never set "project" again -- new details you learn (dates, honoree) can still be included if you do not see them reflected yet. A single dinner or one-off hangout is NOT a project; leave "project" null for those. Once a project is active, plan each event inside it as its own plan, and feel free to coordinate multiple events at once.
- Asking a sensitive question privately over DM instead of in the group, by setting "private_question" (group threads only). Use this when the answer is something a person might not want to say in front of the group (e.g. "what's a realistic amount to chip in for the gift?", or a private availability/budget check tied to a group decision). Never ask a sensitive question like this directly in the group -- set "private_question" instead and tell the group in your "reply" that you're checking with everyone individually. Each person will be DMed your exact question, and only a combined, anonymous summary comes back to the group -- you never see who said what.

When a group needs a suggestion (a venue, an activity, a plan), silently satisfy every constraint listed under "Group constraints to satisfy privately" below, if present. Pick something that works for everyone's budget, dietary needs, and preferences simultaneously. NEVER say which person's constraint drove which part of the choice, and never say things like "since Alex is vegetarian" or "to fit Sam's budget" in a group reply -- just make the good choice silently, the way a thoughtful host would.

You can also call the search_venues tool whenever you're about to suggest a specific place, so you never invent a venue that doesn't exist.

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
  "project": { "type": "bachelorette" | "milestone_birthday" | "reunion" | "trip" | string, "honoree": string | null, "date_range_start": string | null, "date_range_end": string | null } | null
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
  task_action?: {
    kind?: unknown;
    title?: unknown;
    owner_name?: unknown;
    due_date?: unknown;
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
  // Accumulates venue metadata from every search_venues tool call this turn.
  // De-duplicated by venueId so multiple searches for the same venue don't
  // queue up two identical carousels.
  const carouselAccumulator: VenueCarouselEntry[] = [];
  const seenVenueIds = new Set<number>();

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
      tools: AGENT_TOOLS,
      messages,
    });

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
        if (!seenVenueIds.has(entry.venueId)) {
          seenVenueIds.add(entry.venueId);
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

  const globalGuidance = await getGlobalGuidance();

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
            `  IMPORTANT: the agent never holds, moves, or guarantees money. Never say "I've collected" or "I'll send the money". Language must be: "I've recorded that..." or "I noted that...".`,
        },
      ]
    : [];

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    // Ops-authored cross-cutting guidance injected when non-empty.
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
    taskAction,
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
