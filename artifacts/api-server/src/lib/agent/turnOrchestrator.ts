import { db, threadParticipantsTable, usersTable, type Project } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  findOrCreateDirectThread,
  findOrCreateGroupThread,
  findOrCreateUser,
  loadThreadContext,
  markGroupIntroduced,
  resolveGroupParticipants,
  setThreadHomeCityIfUnset,
  type ThreadContext,
} from "./context";
import { applyProfileUpdates, runAgentTurn, type AgentTurnResult } from "./engine";
import { checkAndSendGroupKickoffRecap } from "./onboardingFlow";
import { scrubPrivateProfileLeaks } from "./privacy";
import { sendToThread } from "./delivery";
import { createPoll } from "./polls";
import { draftBooking } from "./bookings";
import { getActivePlan, getOrCreateActivePlan } from "./plans";
import { createProjectForThread, getActiveProject, getOrganizerForProject } from "./projects";
import { instantiateTimeline, recomputeDueDates } from "./projectTimeline";
import { suggestDestinations, setProjectDestinationPoll, formatDateWindow } from "./destinationSuggestions";
import {
  createProposal,
  buildOrganizerPreviewMessage,
  type ProposalType,
  type ProposalContent,
  type PollProposalContent,
  type VenueShortlistProposalContent,
  type ItineraryProposalContent,
} from "./projectProposals";
import { buildItinerary, renderItineraryAsText } from "./itinerary";
import { startArrivalCollection } from "./arrivalMatrix";
import { scheduleNonVoterNudge } from "./scheduler";
import { captureOccasion, linkOccasionsToProject } from "./occasions";
import { createPrivateInputRequest } from "./privateInput";
import { createGroupWithNumbers } from "../sendblue";
import { recordActivationEvent } from "./activation";
import { applyOrganizerActions } from "./organizerActions";
import { sendContactCardIfNeeded } from "./contactCard";
import { sendVenueCarousels } from "./carouselDelivery";
import { buildPublicUrl } from "../publicUrl";
import { logger } from "../logger";

// ─── Unified turn orchestration ─────────────────────────────────────────────
// Single spine for every LLM conversation turn: group threads, plain 1:1 DMs,
// and the organizer's private sidebar. Shared post-processing (profile
// updates, display name) runs once here; context-specific behavior is a
// small, explicit branch (sidebar actions vs group/1:1 actions) so a fix to
// shared behavior lands in every path automatically.
//
// Invoked from a debounced timer (see `scheduleAgentTurn`) rather than inline
// in the webhook handler, so a burst of rapid-fire messages collapses into a
// single agent turn instead of one per message. Because messages are
// persisted before this runs, the batched turn sees the full burst via its
// normal transcript load.

/**
 * Pattern that matches "itinerary" near a link/share intent in the same
 * message. Catches: "send me the itinerary link", "share the itinerary url",
 * "can you send the itinerary", "itinerary link please", etc.
 */
const ITINERARY_LINK_PATTERN = /itinerary/i;
const ITINERARY_LINK_INTENT = /\b(link|url|send|share|get|show|give)\b/i;

/**
 * Matches organizer requests to collect arrival details from the group.
 * "collect arrival info", "ask everyone when they're arriving", "gather
 * flight details", "start arrival collection", etc.
 */
const ARRIVAL_COLLECTION_PATTERN =
  /\b(collect|gather|ask|start|send|get)\b.{0,40}\barriv|\barriv\w*\s+(info|detail|form|collection|round|survey|\bwhen\b)|\bflight\s+(info|detail|number)/i;

export interface ConversationTurnOptions {
  /**
   * When set, this turn is the organizer's private sidebar 1:1 DM. The active
   * project is injected as sidebar context so the engine is aware of its role,
   * and output is NOT gated through the proposal flow (sidebar replies go
   * straight back to the organizer, not to the group).
   */
  sidebarProject?: Project;
}

/**
 * Runs the main conversation engine for a thread and delivers the result.
 * This is the single entry point for all agent turns — the webhook handler
 * schedules it through the debounce layer for group, 1:1, and sidebar turns.
 */
export async function processConversationTurn(
  threadId: number,
  senderUserId: number,
  options: ConversationTurnOptions = {},
): Promise<void> {
  const context = await loadThreadContext(threadId);
  const sidebarProject = options.sidebarProject ?? null;

  // ── Deterministic shortcuts (no LLM turn) ──────────────────────────────────
  if (sidebarProject) {
    if (await handleSidebarShortcuts(context, threadId, senderUserId, sidebarProject)) return;
  } else if (await handleGroupItineraryShortcut(context, threadId)) {
    return;
  }

  // ── LLM turn ───────────────────────────────────────────────────────────────
  const result = sidebarProject
    ? await runAgentTurn(context, senderUserId, { sidebarProject })
    : await runAgentTurn(context, senderUserId);

  // ── Shared post-processing (every context) ─────────────────────────────────
  if (result.profileUpdates) {
    await applyProfileUpdates(senderUserId, result.profileUpdates);
  }
  if (result.displayName) {
    await db.update(usersTable).set({ displayName: result.displayName }).where(eq(usersTable.id, senderUserId));
  }

  // ── Context-specific actions + delivery ────────────────────────────────────
  if (sidebarProject) {
    await applyOrganizerActions(result, sidebarProject, senderUserId);
    await sendContactCardIfNeeded(senderUserId, context.thread.primaryPhoneNumber!);
    await sendToThread(threadId, result.reply);
    return;
  }

  await applyGroupTurnActionsAndDeliver(context, threadId, senderUserId, result);
}

// ─── Sidebar shortcuts ───────────────────────────────────────────────────────

/**
 * Deterministic organizer-sidebar shortcuts that skip the LLM: arrival
 * collection rounds and itinerary link requests. Returns true when the
 * message was fully handled.
 */
async function handleSidebarShortcuts(
  context: ThreadContext,
  threadId: number,
  senderUserId: number,
  organizerProject: Project,
): Promise<boolean> {
  const lastUserMsg = [...context.recentMessages].reverse().find((m) => m.role === "user");

  // ── Arrival collection shortcut ────────────────────────────────────────────
  // When the organizer asks to collect arrival info, skip the LLM and start
  // the collection round directly so the intent is never mis-interpreted.
  if (lastUserMsg && ARRIVAL_COLLECTION_PATTERN.test(lastUserMsg.content)) {
    try {
      const groupThreadId = organizerProject.threadId;
      const requestId = await startArrivalCollection(organizerProject.id, groupThreadId);

      // DM each group participant (excluding the organizer) asking for arrival details.
      const participants = await db
        .select({ userId: threadParticipantsTable.userId })
        .from(threadParticipantsTable)
        .where(eq(threadParticipantsTable.threadId, groupThreadId));

      // DM every group participant — including the organizer, so that
      // isPrivateInputComplete (which counts all thread participants) can
      // reach 100 %. The organizer should share their own arrival info too.
      let sentCount = 0;
      for (const { userId } of participants) {
        try {
          const [member] = await db
            .select({ phoneNumber: usersTable.phoneNumber })
            .from(usersTable)
            .where(eq(usersTable.id, userId));
          if (!member?.phoneNumber) continue;
          const { thread: dmThread } = await findOrCreateDirectThread(member.phoneNumber);
          await sendToThread(
            dmThread.id,
            "Hey! Quick question about the trip: what are your arrival details? Share your flight number and arrival time if flying, or when you expect to arrive if driving.",
          );
          sentCount++;
        } catch (err) {
          logger.warn({ err, userId }, "Failed to DM participant for arrival collection; continuing");
        }
      }

      await sendContactCardIfNeeded(senderUserId, context.thread.primaryPhoneNumber!);
      await sendToThread(
        threadId,
        `On it — I've sent a private message to ${sentCount} group ${sentCount === 1 ? "member" : "members"} asking for their arrival details (request #${requestId}). I'll let you know when everyone responds.`,
      );
    } catch (err) {
      logger.error({ err, projectId: organizerProject.id }, "Failed to start arrival collection");
      await sendToThread(threadId, "Sorry, something went wrong starting the arrival collection. Try again in a moment.");
    }
    return true;
  }

  // ── Itinerary link shortcut ────────────────────────────────────────────────
  // Detect "send me the itinerary link" style requests without burning an LLM
  // turn. Reply with the URL directly so the organizer can paste it anywhere.
  if (
    lastUserMsg &&
    ITINERARY_LINK_PATTERN.test(lastUserMsg.content) &&
    ITINERARY_LINK_INTENT.test(lastUserMsg.content)
  ) {
    const url = buildPublicUrl(`projects/${organizerProject.id}/itinerary`);
    await sendContactCardIfNeeded(senderUserId, context.thread.primaryPhoneNumber!);
    if (url) {
      // Also inline a text preview so the organizer can see there's content.
      try {
        const itinerary = await buildItinerary(organizerProject.id);
        const preview = itinerary ? renderItineraryAsText(itinerary) : null;
        if (preview) {
          await sendToThread(threadId, preview);
        }
      } catch (err) {
        logger.warn({ err }, "Failed to render itinerary preview for sidebar link reply");
      }
      await sendToThread(threadId, `Here's the itinerary link: ${url}`);
    } else {
      await sendToThread(threadId, `I don't have a public URL configured yet. Your ops team can access it at /api/projects/${organizerProject.id}/itinerary on the dashboard server.`);
    }
    return true;
  }

  return false;
}

// ─── Group/1:1 turn actions ─────────────────────────────────────────────────

/**
 * In-thread itinerary request: when an organizer (or group member) asks
 * "make us an itinerary" in a group thread that has an active project, skip
 * the LLM and send a structured text summary directly. This is faster,
 * deterministic, and always up-to-date. Returns true when handled.
 */
async function handleGroupItineraryShortcut(context: ThreadContext, threadId: number): Promise<boolean> {
  if (!context.thread.isGroup) return false;
  if (!ITINERARY_LINK_PATTERN.test(context.recentMessages.at(-1)?.content ?? "")) return false;

  const activeProject = await getActiveProject(threadId);
  if (!activeProject) return false;
  try {
    const itinerary = await buildItinerary(activeProject.id);
    if (itinerary && itinerary.days.length > 0) {
      const text = renderItineraryAsText(itinerary);
      await sendToThread(threadId, text);
      const url = buildPublicUrl(`projects/${activeProject.id}/itinerary`);
      if (url) {
        await sendToThread(threadId, `Full itinerary: ${url}`);
      }
      return true;
    }
    // Fall through to LLM if no scheduled events yet — it can respond naturally.
  } catch (err) {
    logger.warn({ err, threadId }, "Failed to build itinerary for in-thread request; falling through to LLM");
  }
  return false;
}

/**
 * Applies the structured actions of a group or plain-1:1 turn result and
 * delivers the reply: onboarding status, home city, project creation, the
 * destination shortlist flow, the organizer approval gate, polls, occasions,
 * private questions, booking drafts, group creation, and carousels.
 */
async function applyGroupTurnActionsAndDeliver(
  context: ThreadContext,
  threadId: number,
  senderUserId: number,
  result: AgentTurnResult,
): Promise<void> {
  const isGroup = context.thread.isGroup;

  if (result.onboardingComplete !== null) {
    await db
      .update(usersTable)
      .set({ onboardingStatus: result.onboardingComplete ? "completed" : "in_progress" })
      .where(eq(usersTable.id, senderUserId));

    if (result.onboardingComplete) {
      void recordActivationEvent(senderUserId, "onboarding_complete");
      await checkAndSendGroupKickoffRecap(senderUserId);
    }
  }

  if (result.homeCity && isGroup && !context.thread.homeCity) {
    // Scoped to the thread the mention actually happened in -- applying it
    // to every group the sender belongs to risked mislabeling an unrelated
    // group (e.g. a one-off trip-planning thread) with a city that only
    // made sense in this conversation.
    await setThreadHomeCityIfUnset(threadId, result.homeCity);
  }

  // Project creation must run before poll/booking handling so an event
  // coordinated in the same turn hangs off a project child plan, not a
  // standalone one.
  if (result.project) {
    const honoreeUser = result.project.honoree
      ? context.participants.find(
          (p) => p.user.displayName?.toLowerCase() === result.project?.honoree?.toLowerCase(),
        )?.user
      : undefined;
    const { project, created } = await createProjectForThread({
      threadId,
      type: result.project.type,
      honoree: result.project.honoree,
      honoreeUserId: honoreeUser?.id ?? null,
      dateRangeStart: result.project.dateRangeStart,
      dateRangeEnd: result.project.dateRangeEnd,
      // Sender becomes the default organizer; they can hand off via conversation later.
      organizerUserId: senderUserId,
    });
    logger.info(
      { threadId, projectId: project.id, type: project.type, created },
      created ? "Project created from conversation" : "Project details merged into existing active project",
    );

    // Timeline: instantiate steps on first creation; recompute due dates when
    // the date range is updated via a subsequent conversation turn.
    if (created) {
      await instantiateTimeline(project);
    } else if (result.project.dateRangeStart || result.project.dateRangeEnd) {
      await recomputeDueDates(project);
    }

    // A3: Link any unlinked occasions in this thread that match the project's
    // honoree so the daily occasion-scan suppression works even for name-only
    // matches (where honoreeUserId is null on both sides).
    if (result.project.honoree || honoreeUser?.id) {
      void linkOccasionsToProject(
        project.id,
        threadId,
        honoreeUser?.id ?? null,
        result.project.honoree,
      ).catch((err) =>
        logger.warn({ err, projectId: project.id }, "linkOccasionsToProject failed; continuing"),
      );
    }
  }

  // ── Destination shortlist request ──────────────────────────────────────────
  // When the agent sets `destination_suggestion_request: true` for a trip
  // project with no destination, run a web-search call to produce 3–5
  // candidates and immediately send a destination choice poll to the group.
  // Destination polls bypass the organizer approval gate — they are the
  // framing question, not a downstream event choice.
  if (result.destinationSuggestionRequest && isGroup) {
    const tripProject = await getActiveProject(threadId);
    if (tripProject && tripProject.type === "trip" && !tripProject.destination) {
      // Gather context for the suggestion call.
      const budgets = context.participants
        .map((p) => p.profile?.budget)
        .filter((b): b is string => typeof b === "string" && b.length > 0);
      const budget = budgets.length > 0 ? budgets[0] : null;
      const dateWindow = formatDateWindow(tripProject.dateRangeStart, tripProject.dateRangeEnd);
      const originCity = context.thread.homeCity ?? null;
      const groupSize = context.participants.length;

      const shortlist = await suggestDestinations(budget, dateWindow, originCity, groupSize);
      if (shortlist && shortlist.candidates.length >= 2) {
        // Create the destination poll. No plan anchor — destination selection
        // is a project-level decision, not tied to a specific child plan.
        const pollQuestion = "Where are we going?";
        const pollOptions = shortlist.candidates.map((c) => c.label);
        const { poll, options } = await createPoll(threadId, pollQuestion, pollOptions, { kind: "choice" });

        // Schedule the same non-voter nudge + tiebreak announce/lock pipeline used by
        // all other choice polls — without this, a destination poll with partial votes
        // stalls forever and the scheduler tiebreak-lock path is unreachable.
        await scheduleNonVoterNudge(threadId, poll.id);

        // Record which poll is the destination poll on the project.
        await setProjectDestinationPoll(tripProject.id, poll.id);

        // Announce with the intro line and each candidate + vibe note.
        await sendToThread(threadId, shortlist.intro);
        for (const [index, candidate] of shortlist.candidates.entries()) {
          const option = options[index];
          if (!option) continue;
          await sendToThread(threadId, `${index + 1}. ${candidate.label} — ${candidate.vibeNote} (${candidate.roughCostContext})`);
        }
        await sendToThread(threadId, "Tap/reply with your pick. Everyone vote and I'll lock it in.");
        void options; // options already used above
        logger.info(
          { projectId: tripProject.id, pollId: poll.id, candidateCount: shortlist.candidates.length },
          "Destination shortlist poll sent",
        );
      } else {
        logger.warn({ projectId: tripProject.id }, "Destination suggestion returned no usable candidates; sending fallback reply");
        await sendToThread(threadId, result.reply);
      }
      return;
    }
  }

  // ── Organizer approval gate ─────────────────────────────────────────────────
  // If this group thread has an active project with an organizer, hold polls
  // and venue shortlists in the pending_project_proposals queue for organizer
  // review before releasing them to the group. The organizer gets a DM preview
  // and approves/rejects from their private sidebar.
  if (isGroup) {
    const gateProject = await getActiveProject(threadId);
    if (gateProject?.organizerUserId && (result.poll || (result.venueCarousels?.length ?? 0) > 0 || (result.itineraryEvents?.length ?? 0) > 0)) {
      const type: ProposalType = result.poll
        ? "poll"
        : (result.itineraryEvents?.length ?? 0) > 0
          ? "itinerary"
          : "venue_shortlist";
      const scrubbed = scrubPrivateProfileLeaks(result.reply, context.participants);

      let proposalContent: ProposalContent;
      if (result.poll) {
        proposalContent = {
          question: result.poll.question,
          options: result.poll.options,
          kind: result.poll.kind,
          optionDates: result.poll.optionDates.map((d) => d?.toISOString() ?? null),
          reply: scrubbed,
        } satisfies PollProposalContent;
      } else if (result.itineraryEvents && result.itineraryEvents.length > 0) {
        proposalContent = {
          reply: scrubbed,
          events: result.itineraryEvents,
        } satisfies ItineraryProposalContent;
      } else {
        proposalContent = {
          reply: scrubbed,
          venueCarousels: result.venueCarousels ?? [],
        } satisfies VenueShortlistProposalContent;
      }

      // Persist before sending DM (fail toward under-not double-sending).
      await createProposal(gateProject.id, threadId, type, proposalContent);

      const organizer = await getOrganizerForProject(gateProject);
      if (organizer?.phoneNumber) {
        const { thread: orgThread } = await findOrCreateDirectThread(organizer.phoneNumber);
        await sendToThread(orgThread.id, buildOrganizerPreviewMessage(type, proposalContent));
      }

      // Acknowledge to the group without revealing the draft content.
      await sendToThread(threadId, "On it — checking a few things, back shortly.");
      return; // Skip normal poll creation, reply send, and carousels.
    }
  }
  // ── End organizer gate ──────────────────────────────────────────────────────

  if (result.poll && isGroup) {
    const plan = await getOrCreateActivePlan(threadId, result.poll.question);
    const { poll, options } = await createPoll(threadId, result.poll.question, result.poll.options, {
      kind: result.poll.kind,
      planId: plan.id,
      optionDates: result.poll.optionDates,
    });
    // Tiebreaker persona (and reliable tapback voting) apply to any poll
    // that can stall, not just date polls -- schedule the escalation path
    // for both kinds.
    await scheduleNonVoterNudge(threadId, poll.id);

    // Each option gets its own bubble so a tapback on it is unambiguous
    // (see `parseTapback` -- iMessage quotes the whole reacted message).
    for (const [index, option] of options.entries()) {
      await sendToThread(threadId, `${index + 1}. ${option.label}`);
    }
  }

  if (result.occasion) {
    const aboutUser = result.occasion.aboutName
      ? context.participants.find(
          (p) => p.user.displayName?.toLowerCase() === result.occasion?.aboutName?.toLowerCase(),
        )?.user
      : undefined;
    await captureOccasion({
      threadId,
      aboutUserId: aboutUser?.id ?? null,
      mentionedByUserId: senderUserId,
      kind: result.occasion.kind,
      label: result.occasion.label,
      occasionDate: result.occasion.date,
    });
    // TODO: on acceptance, create project + link via occasions.projectId
    // When the organizer replies "yes" to an occasion reminder, create a project
    // and then: await db.update(occasionsTable).set({ projectId: newProject.id }).where(eq(occasionsTable.id, occasion.id));
  }

  if (result.privateQuestion && isGroup) {
    const plan = await getActivePlan(threadId);
    const request = await createPrivateInputRequest(threadId, plan?.id ?? null, result.privateQuestion);
    for (const { user } of context.participants) {
      if (!user.phoneNumber) continue;
      const { thread: dmThread } = await findOrCreateDirectThread(user.phoneNumber);
      await sendToThread(dmThread.id, result.privateQuestion);
    }
    // Track which request each DM thread is currently answering isn't
    // needed explicitly -- `getOpenPrivateInputRequestForUser` resolves it
    // by joining through thread_participants, since a request is keyed to
    // the group thread and every participant is a member of it.
    void request;
  }

  if (result.bookingDraft) {
    const approverPhone = result.bookingDraft.approverPhoneNumber;
    const approver = approverPhone ? (await findOrCreateUser(approverPhone)).user : { id: senderUserId };
    const plan = await getOrCreateActivePlan(threadId, result.bookingDraft.title);
    const booking = await draftBooking({
      threadId,
      planId: plan.id,
      createdByUserId: senderUserId,
      approverUserId: approver.id,
      title: result.bookingDraft.title,
      details: result.bookingDraft.details,
    });

    if (approver.id !== senderUserId) {
      const { thread: approverThread } = await findOrCreateDirectThread(approverPhone as string);
      await sendToThread(
        approverThread.id,
        `Heads up -- can you approve this booking: "${booking.title}"? Reply YES to confirm or NO to skip it.`,
      );
    }
  }

  // ── Instant group creation (1:1 only) ───────────────────────────────────────
  // When the user asks the concierge to start a group with specific people,
  // try to create it via Sendblue. Fall back to manual instructions if
  // Sendblue doesn't support programmatic group creation (undocumented path).
  if (result.groupCreationRequest && !isGroup) {
    const gcr = result.groupCreationRequest;

    // Safe, scoped resolution: explicit phones always flow through; name lookup
    // is constrained to the sender's shared contacts and requires a unique match.
    const { resolvedPhones, ambiguousNames, unknownNames } = await resolveGroupParticipants(
      senderUserId,
      gcr.participantNames,
      gcr.participantPhones,
    );

    if (ambiguousNames.length > 0) {
      // Multiple contacts share the same name — can't pick safely.
      await sendToThread(
        threadId,
        `I found multiple contacts named ${ambiguousNames.join(" and ")} -- could you share their phone number(s) directly so I get the right person?`,
      );
    } else if (unknownNames.length > 0 && resolvedPhones.length === 0) {
      // No phones at all — can't create any group.
      await sendToThread(
        threadId,
        `I don't have contact info for ${unknownNames.join(" and ")} yet -- add me to a new iMessage thread with them and I'll take it from there.`,
      );
    } else if (resolvedPhones.length > 0) {
      // Always include the requesting user so they're in the group they asked
      // for -- omitting them would make the thread invisible to the person
      // who triggered the creation.
      const senderPhone = context.participants.find((p) => p.user.id === senderUserId)?.user.phoneNumber;
      if (senderPhone && !resolvedPhones.includes(senderPhone)) {
        resolvedPhones.push(senderPhone);
      }

      // Attempt Sendblue group creation with all phones we have.
      const introMessage = `Hi all -- I'm an AI concierge${gcr.occasion ? ` helping plan ${gcr.occasion}` : ""}. I'll help coordinate things here (polls, bookings, reminders).`;
      const newGroupId = await createGroupWithNumbers(resolvedPhones, introMessage);

      if (newGroupId) {
        // Sendblue created the group -- record it in our DB.
        const { thread: newGroupThread } = await findOrCreateGroupThread(newGroupId, resolvedPhones);
        await markGroupIntroduced(newGroupThread.id);
        const missingNote = unknownNames.length > 0
          ? ` (I couldn't add ${unknownNames.join(" and ")} -- you may need to add them manually.)`
          : "";
        await sendToThread(threadId, `Done -- I've started the group and introduced myself. Jump in there when you're ready!${missingNote}`);
      } else {
        // Sendblue doesn't support programmatic creation; give manual instructions.
        const names = gcr.participantNames.join(" and ");
        await sendToThread(
          threadId,
          `I can't create the group directly -- add me to a new iMessage thread with ${names || "them"} and I'll take it from there.`,
        );
      }
    }
    // Skip the LLM reply when a group creation was attempted -- the action
    // messages above are the response.
    return;
  }

  // Preference privacy enforcement: private profile fields may have silently
  // shaped this reply, but they must never surface verbatim in group-visible
  // text. 1:1 threads skip this -- there's nothing to leak the info to.
  const outgoingReply = isGroup ? scrubPrivateProfileLeaks(result.reply, context.participants) : result.reply;

  // Send the concierge contact card as a media attachment on the very first
  // outbound 1:1 DM so the user can save the number. 1:1 only — group threads
  // don't need it and Sendblue may reject contact cards on group sends.
  if (!isGroup && context.thread.primaryPhoneNumber) {
    await sendContactCardIfNeeded(senderUserId, context.thread.primaryPhoneNumber);
  }

  await sendToThread(threadId, outgoingReply);

  // Photo carousels follow the text recommendation as a burst of swipeable
  // images. Fire-and-forget: a photo hiccup must never delay the text reply.
  if (result.venueCarousels?.length) {
    void sendVenueCarousels(threadId, result.venueCarousels);
  }
}
