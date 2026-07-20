import { Router, type IRouter } from "express";
import { ReceiveSendblueWebhookBody, ReceiveSendblueWebhookParams } from "@workspace/api-zod";
import {
  claimInboundMessage,
  findOrCreateDirectThread,
  findOrCreateGroupThread,
  findOrCreateUser,
  getGroupThreadsForUser,
  getParticipantsNeedingDisclosure,
  hasGroupBeenIntroduced,
  hasMessageWithHandle,
  isParticipantMuted,
  loadThreadContext,
  markDisclosureSent,
  markGroupIntroduced,
  threadHasOptedOutParticipant,
  recordMessage,
  resolveGroupParticipants,
  setParticipantMuted,
  setThreadHomeCityIfUnset,
} from "../../lib/agent/context";
import { checkAndSendGroupKickoffRecap, handleDirectOnboardingStep } from "../../lib/agent/onboardingFlow";
import { applyProfileUpdates, runAgentTurn } from "../../lib/agent/engine";
import { scheduleAgentTurn } from "../../lib/agent/debounce";
import { scrubPrivateProfileLeaks } from "../../lib/agent/privacy";
import { sendToThread } from "../../lib/agent/delivery";
import { detectKnowledgeCommand, handleKnowledgeCommand } from "../../lib/agent/knowledge";
import { checkPlanningIntentWithLLM, detectMuteCommand, detectSupportFlag, shouldRespondInGroup } from "../../lib/agent/etiquette";
import {
  buildPersonalityConfirmation,
  buildPracticalConfirmation,
  extractName,
  extractPersonality,
  extractPractical,
  getOnboardingStep,
  ONBOARDING,
} from "../../lib/agent/onboarding";
import {
  clearTiebreak,
  closePollWithWinner,
  computeDatePollWinner,
  countDistinctVoters,
  createPoll,
  getOpenPoll,
  matchOption,
  matchOptions,
  parseTapback,
  recordVote,
  recordVotes,
  tallyPoll,
} from "../../lib/agent/polls";
import {
  confirmBooking,
  detectApprovalIntent,
  draftBooking,
  findPendingBookingForApprover,
  rejectBookingRecord,
} from "../../lib/agent/bookings";
import { confirmPlan, getActivePlan, getOrCreateActivePlan, setPlanScheduledFor, setPlanVenue, setPendingFeedback } from "../../lib/agent/plans";
import {
  createProjectForThread,
  getActiveProject,
  getActiveProjectForOrganizer,
  getOrganizerForProject,
} from "../../lib/agent/projects";
import { instantiateTimeline, recomputeDueDates } from "../../lib/agent/projectTimeline";
import {
  recordEstimates,
  recordPayment,
  recordCommitment,
  findThreadMemberByName,
  getProjectMemberIds,
  buildPaymentRequestMessage,
  getLedgerBalances,
  formatDollars,
  markRequestSent,
} from "../../lib/agent/ledger";
import {
  createActionItem,
  closeActionItem,
  findMemberByNameInThread,
} from "../../lib/agent/actionItems";
import { createCommitmentPoll, isCommitmentPoll, COMMITMENT_IN_LABEL, COMMITMENT_OUT_LABEL } from "../../lib/agent/commitmentPoll";
import {
  suggestDestinations,
  setProjectDestination,
  setProjectDestinationPoll,
  getProjectByDestinationPollId,
  formatDateWindow,
} from "../../lib/agent/destinationSuggestions";
import {
  createProposal,
  getOldestPendingProposal,
  approveProposal,
  rejectProposal,
  releaseProposal,
  buildOrganizerPreviewMessage,
  isApprovalReply,
  isRejectionReply,
  isTiebreakOverride,
  type ProposalType,
  type ProposalContent,
  type PollProposalContent,
  type VenueShortlistProposalContent,
} from "../../lib/agent/projectProposals";
import type { Project } from "@workspace/db";
import { buildGoogleCalendarLink, buildIcsUrl, describePlanSchedule } from "../../lib/agent/calendar";
import { scheduleDayBeforeReminder, scheduleNonVoterNudge } from "../../lib/agent/scheduler";
import { buildReservationLinks, describeReservationLinks } from "../../lib/agent/bookingLinks";
import { buildPlanCardMediaUrl } from "../../lib/agent/planCard";
import { captureOccasion } from "../../lib/agent/occasions";
import { recordPastChoice } from "../../lib/agent/tasteEngine";
import { findVenueIdByName, logIgnoredVenuesForThread, markVenuePicked, recordVenueFeedback } from "../../lib/agent/venueCorpus/recommendationLog";
import {
  aggregatePrivateInput,
  createPrivateInputRequest,
  getOpenPrivateInputRequestForUser,
  isPrivateInputComplete,
  recordPrivateInputResponse,
  resolvePrivateInputRequest,
} from "../../lib/agent/privateInput";
import { feedbackTable, db, plansTable, profilesTable, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createGroupWithNumbers, sendCarousel, sendDirectMessage, sendGroupMessage, sendReaction, uploadMediaToSendblue } from "../../lib/sendblue";
import { generateGroupIntroMessage } from "../../lib/agent/groupIntro";
import { fetchGooglePlacesPhotos, findGooglePlaceIdByName, type VenueCarouselEntry } from "../../lib/agent/tools";
import { logger } from "../../lib/logger";
import { recordActivationEvent } from "../../lib/agent/activation";
import { privacyPolicyUrl } from "../../lib/publicUrl";

/** iMessage tapback text on this poll's own announcement bubbles counts as a vote (Phase 2 texting UX polish). */
const OBJECTION_PATTERN = /\b(no|nope|wait|hold on|object|objection|don'?t lock|actually)\b/i;

/**
 * Sends a photo carousel for each shortlisted venue after the text reply.
 * Best-effort: any failure for an individual venue is logged and skipped —
 * a broken photo fetch must never delay or block the main reply flow.
 *
 * The carousels are intentionally fire-and-forget (`void`) from the call
 * site: they arrive as a follow-on burst of photos, the way a person might
 * text "here are some pics" right after a recommendation.
 */
/**
 * Sends contact card to a user on their very first outbound DM. This lets
 * them save the number as "Concierge" so future messages feel personal.
 * Marks-before-send so a crash fails toward under-sending, not double-sending.
 */
async function sendContactCardIfNeeded(userId: number, phone: string): Promise<void> {
  const [user] = await db.select({ contactCardSent: usersTable.contactCardSent }).from(usersTable).where(eq(usersTable.id, userId));
  if (!user || user.contactCardSent) return;

  const base =
    process.env["PUBLIC_API_URL"] ??
    (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}/api-server` : null);

  if (!base) return; // no public URL configured; skip silently

  const vcfUrl = `${base.replace(/\/$/, "")}/concierge.vcf`;

  await db.update(usersTable).set({ contactCardSent: true }).where(eq(usersTable.id, userId));
  try {
    await sendDirectMessage({ to: phone, content: "", mediaUrl: vcfUrl });
  } catch (error) {
    logger.warn({ error, userId }, "Failed to send contact card; resetting flag");
    await db.update(usersTable).set({ contactCardSent: false }).where(eq(usersTable.id, userId));
  }
}

async function sendVenueCarousels(threadId: number, entries: VenueCarouselEntry[]): Promise<void> {
  try {
    const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
    if (!thread) return;

    // Photo-first voting: when there is an active poll, send each venue as an
    // individual photo bubble whose content is the venue name. A tapback
    // ("Loved "Lilia"") on that bubble is then picked up by parseTapback →
    // matchOption and registered as a vote — no separate voting UI needed.
    // When there is no active poll, fall back to the original multi-image carousel.
    const activePoll = await getOpenPoll(threadId);

    for (const entry of entries) {
      try {
        // Prefer the stored Google Place ID; fall back to a text search when the
        // venue was added to the corpus before the field was populated.
        let placeId = entry.googlePlaceId;
        if (!placeId) {
          placeId = await findGooglePlaceIdByName(entry.venueName);
          if (!placeId) {
            logger.debug({ venueName: entry.venueName }, "No Google Place ID found; skipping photo for this venue");
            continue;
          }
        }

        // Voting mode only needs 1 photo; carousel mode needs ≥ 2.
        const neededPhotos = activePoll ? 1 : 2;
        const photoUrls = await fetchGooglePlacesPhotos(placeId, 4);

        if (photoUrls.length < 1) {
          logger.debug({ venueName: entry.venueName }, "No photos returned; skipping this venue");
          continue;
        }

        // Google Places photo URIs are short-lived and Google-hosted. Sendblue
        // requires its own CDN-hosted URLs, so we download and upload each.
        // Stop uploading once we have enough for the chosen send mode.
        const uploadedUrls: string[] = [];
        for (const photoUrl of photoUrls) {
          const imgResp = await fetch(photoUrl);
          if (!imgResp.ok) continue;
          const buffer = Buffer.from(await imgResp.arrayBuffer());
          const contentType = imgResp.headers.get("content-type") ?? "image/jpeg";
          const ext = contentType.includes("png") ? "png" : "jpg";
          const safeName = entry.venueName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
          const uploaded = await uploadMediaToSendblue(buffer, `${safeName}-${uploadedUrls.length}.${ext}`, contentType);
          if (uploaded) {
            uploadedUrls.push(uploaded);
            if (uploadedUrls.length >= neededPhotos) break;
          }
        }

        if (uploadedUrls.length < 1) {
          logger.debug({ venueName: entry.venueName }, "No photos uploaded; skipping this venue");
          continue;
        }

        if (activePoll) {
          // Individual bubble per venue: tapback on it = vote for that venue.
          if (thread.isGroup && thread.sendblueGroupId) {
            await sendGroupMessage({ groupId: thread.sendblueGroupId, content: entry.venueName, mediaUrl: uploadedUrls[0] });
          } else if (thread.primaryPhoneNumber) {
            await sendDirectMessage({ to: thread.primaryPhoneNumber, content: entry.venueName, mediaUrl: uploadedUrls[0] });
          }
        } else {
          if (uploadedUrls.length < 2) {
            logger.debug({ venueName: entry.venueName }, "Insufficient photos for carousel; skipping");
            continue;
          }
          if (thread.isGroup && thread.sendblueGroupId) {
            await sendCarousel({ groupId: thread.sendblueGroupId, mediaUrls: uploadedUrls });
          } else if (thread.primaryPhoneNumber) {
            await sendCarousel({ to: thread.primaryPhoneNumber, mediaUrls: uploadedUrls });
          }
        }
      } catch (error) {
        logger.warn({ error, venueName: entry.venueName }, "Failed to send venue photo; continuing with remaining venues");
      }
    }
  } catch (error) {
    // Outer guard: thread lookup or setup failure must never surface as an
    // unhandled rejection since this function is always called fire-and-forget.
    logger.warn({ error, threadId }, "sendVenueCarousels failed during setup; skipping all carousels for this turn");
  }
}

const router: IRouter = Router();

/**
 * Releases an organizer-approved proposal to the group thread. Mirrors the
 * normal `processAgentTurn` delivery logic for each proposal type.
 */
async function releasePendingProposalToGroup(
  proposal: import("@workspace/db").ProjectProposal,
  groupThreadId: number,
  organizerThreadId: number,
): Promise<void> {
  // Mark released before sending to fail toward under- not double-sending.
  await releaseProposal(proposal.id);
  const content = proposal.proposalContent as unknown;

  if (proposal.proposalType === "poll") {
    const { question, options, kind, optionDates, reply } = content as PollProposalContent;
    await sendToThread(groupThreadId, reply);
    const plan = await getOrCreateActivePlan(groupThreadId, question);
    const { poll, options: pollOptions } = await createPoll(groupThreadId, question, options, {
      kind,
      planId: plan.id,
      optionDates: (optionDates as (string | null)[]).map((d) => {
        if (!d) return null;
        const parsed = new Date(d);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }),
    });
    await scheduleNonVoterNudge(groupThreadId, poll.id);
    for (const [index, option] of pollOptions.entries()) {
      await sendToThread(groupThreadId, `${index + 1}. ${option.label}`);
    }
  } else if (proposal.proposalType === "venue_shortlist") {
    const { reply, venueCarousels: carousels } = content as unknown as VenueShortlistProposalContent;
    await sendToThread(groupThreadId, reply);
    if (Array.isArray(carousels) && carousels.length > 0) {
      void sendVenueCarousels(groupThreadId, carousels);
    }
  } else {
    // message
    const { reply } = content as { reply: string };
    await sendToThread(groupThreadId, reply);
  }

  await sendToThread(organizerThreadId, "Sent to the group.");
}

/**
 * Agent turn for the organizer's private sidebar 1:1 DM. Injects the active
 * project as sidebar context so the engine is aware of its role. Does NOT
 * gate output through the proposal flow (sidebar replies go straight back to
 * the organizer, not to the group).
 */
async function processOrganizerSidebarTurn(
  threadId: number,
  senderUserId: number,
  organizerProject: Project,
): Promise<void> {
  const context = await loadThreadContext(threadId);
  const result = await runAgentTurn(context, senderUserId, { sidebarProject: organizerProject });

  if (result.profileUpdates) {
    await applyProfileUpdates(senderUserId, result.profileUpdates);
  }
  if (result.displayName) {
    await db.update(usersTable).set({ displayName: result.displayName }).where(eq(usersTable.id, senderUserId));
  }

  // ── Ledger action handling ─────────────────────────────────────────────────
  if (result.ledgerAction) {
    const action = result.ledgerAction;
    const groupThreadId = organizerProject.threadId;

    if (action.kind === "estimate") {
      // Compute per-person amount.
      let perPersonCents: number | null = action.perPersonCents;
      if (!perPersonCents && action.totalCents && action.headcount && action.headcount > 0) {
        perPersonCents = Math.round(action.totalCents / action.headcount);
      }

      if (perPersonCents && perPersonCents > 0) {
        // Create one estimate row per group member (excluding organizer).
        const memberIds = await getProjectMemberIds(groupThreadId, senderUserId);
        const entries = await recordEstimates(organizerProject.id, memberIds, perPersonCents, action.note);

        // Load organizer info for payment request messages.
        const [organizer] = await db
          .select({ displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
          .from(usersTable)
          .where(eq(usersTable.id, senderUserId));

        // Send payment-request DMs to each member 1:1.
        for (const entry of entries) {
          if (!entry.userId) continue;
          try {
            const [member] = await db
              .select({ displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
              .from(usersTable)
              .where(eq(usersTable.id, entry.userId));
            if (!member?.phoneNumber) continue;

            const { thread: memberThread } = await findOrCreateDirectThread(member.phoneNumber);
            const msg = buildPaymentRequestMessage(
              member.displayName ?? member.phoneNumber,
              perPersonCents,
              action.note,
              organizer?.displayName ?? "the organizer",
              organizer?.phoneNumber ?? null,
            );
            await sendToThread(memberThread.id, msg);
            await markRequestSent(entry.id);
          } catch (err) {
            logger.error({ err, userId: entry.userId }, "Failed to send payment request DM; continuing");
          }
        }
      }
    } else if (action.kind === "payment_recorded") {
      if (action.memberName) {
        const member = await findThreadMemberByName(groupThreadId, action.memberName);
        if (member) {
          // If no amount specified, use their full outstanding estimate balance.
          let amountCents = action.amountCents;
          if (!amountCents) {
            const balances = await getLedgerBalances(organizerProject.id);
            const b = balances.find((bl) => bl.userId === member.userId);
            amountCents = b?.outstandingCents ?? 0;
          }
          if (amountCents > 0) {
            await recordPayment(organizerProject.id, member.userId, amountCents, action.note);
            logger.info(
              { projectId: organizerProject.id, userId: member.userId, amountCents },
              "Payment recorded via organizer sidebar",
            );
          }
        } else {
          logger.warn(
            { projectId: organizerProject.id, memberName: action.memberName },
            "Could not resolve member name for payment recording",
          );
        }
      }
    } else if (action.kind === "commitment") {
      if (action.memberName) {
        const member = await findThreadMemberByName(groupThreadId, action.memberName);
        if (member) {
          await recordCommitment(organizerProject.id, member.userId, action.note);
        }
      }
    }
  }

  // ── Task action handling ────────────────────────────────────────────────────
  if (result.taskAction) {
    const action = result.taskAction;
    const groupThreadId = organizerProject.threadId;

    if (action.kind === "create") {
      // Resolve owner by name if provided.
      let ownerUserId: number | null = null;
      if (action.ownerName) {
        const member = await findMemberByNameInThread(groupThreadId, action.ownerName);
        ownerUserId = member?.userId ?? null;
        if (!ownerUserId) {
          logger.warn({ projectId: organizerProject.id, ownerName: action.ownerName }, "Could not resolve action item owner by name");
        }
      }
      await createActionItem(organizerProject.id, action.title, ownerUserId, action.dueDate);
    } else if (action.kind === "close") {
      const closed = await closeActionItem(organizerProject.id, action.title);
      if (!closed) {
        logger.warn({ projectId: organizerProject.id, title: action.title }, "No matching open action item found to close");
      }
    }
  }

  // ── Commitment action handling ─────────────────────────────────────────────
  if (result.commitmentAction) {
    const action = result.commitmentAction;
    const groupThreadId = organizerProject.threadId;
    try {
      const pollId = await createCommitmentPoll(
        organizerProject.id,
        groupThreadId,
        action.deadline,
        action.headcountTarget,
      );

      // Announce the commitment round to the group thread.
      const deadlineStr = action.deadline.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      });
      const targetLine = action.headcountTarget ? ` (target: ${action.headcountTarget} people)` : "";
      await sendToThread(
        groupThreadId,
        `Are you in for the trip?${targetLine} Reply by ${deadlineStr}.\n1. ${COMMITMENT_IN_LABEL}\n2. ${COMMITMENT_OUT_LABEL}`,
      );

      logger.info({ projectId: organizerProject.id, pollId, deadline: action.deadline }, "Commitment round opened via organizer sidebar");
    } catch (err) {
      logger.error({ err, projectId: organizerProject.id }, "Failed to create commitment poll");
    }
  }

  await sendContactCardIfNeeded(senderUserId, context.thread.primaryPhoneNumber!);
  await sendToThread(threadId, result.reply);
}

/**
 * Runs the main conversation engine for a thread and delivers the result.
 * Invoked from a debounced timer (see `scheduleAgentTurn`) rather than
 * inline in the webhook handler, so a burst of rapid-fire messages collapses
 * into a single agent turn instead of one per message. Because messages are
 * persisted before this runs, the batched turn sees the full burst via its
 * normal transcript load.
 */
async function processAgentTurn(threadId: number, senderUserId: number): Promise<void> {
  const context = await loadThreadContext(threadId);
  const isGroup = context.thread.isGroup;
  const result = await runAgentTurn(context, senderUserId);

  if (result.profileUpdates) {
    await applyProfileUpdates(senderUserId, result.profileUpdates);
  }

  if (result.displayName) {
    await db.update(usersTable).set({ displayName: result.displayName }).where(eq(usersTable.id, senderUserId));
  }

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
    if (gateProject?.organizerUserId && (result.poll || (result.venueCarousels?.length ?? 0) > 0)) {
      const type: ProposalType = result.poll ? "poll" : "venue_shortlist";
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

router.post("/webhooks/sendblue/:secret", async (req, res): Promise<void> => {
  const params = ReceiveSendblueWebhookParams.safeParse(req.params);
  const expectedSecret = process.env["SENDBLUE_WEBHOOK_SECRET"];

  // Sendblue does not sign webhook payloads, so the shared secret embedded in
  // the URL we register with them is the only authenticity check available.
  // Reject silently (no 200 ack) rather than processing unauthenticated
  // events -- an attacker with the wrong secret should not be able to inject
  // messages, cast votes, or approve/reject bookings.
  if (!expectedSecret) {
    req.log.error("SENDBLUE_WEBHOOK_SECRET is not configured; rejecting webhook request");
    res.status(503).json({ error: "Webhook not configured" });
    return;
  }
  if (!params.success || params.data.secret !== expectedSecret) {
    req.log.warn("Rejected Sendblue webhook request with invalid secret");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = ReceiveSendblueWebhookBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid Sendblue webhook payload");
    res.status(200).json({ received: true });
    return;
  }

  const event = parsed.data;

  // Ignore delivery-status callbacks for our own outbound sends, and anything
  // without message content -- we only react to actual inbound text.
  if (event.is_outbound || !event.content || !event.from_number) {
    res.status(200).json({ received: true });
    return;
  }

  // Opt-out compliance: Sendblue sets `is_spam: true` when the recipient
  // replies with a standard STOP/UNSUBSCRIBE keyword. Mute them in all their
  // threads and skip agent processing -- do not reply to an opt-out message.
  const rawBody = req.body as Record<string, unknown>;
  if (rawBody["is_spam"] === true) {
    req.log.warn({ fromNumber: event.from_number }, "Sendblue is_spam opt-out received; muting sender");
    try {
      const { user, thread } = await findOrCreateDirectThread(event.from_number);
      await setParticipantMuted(thread.id, user.id, true);
      // Also mute in any group threads this user participates in.
      const groupRows = await getGroupThreadsForUser(user.id);
      await Promise.all(groupRows.map(({ id }) => setParticipantMuted(id, user.id, true)));
    } catch (err) {
      req.log.error({ err, fromNumber: event.from_number }, "Failed to mute opted-out sender");
    }
    res.status(200).json({ received: true });
    return;
  }

  // Cheap pre-check: Sendblue retries webhook deliveries on any
  // non-2xx/timeout response, and this handler can take a while (LLM turn,
  // multiple sends) -- so the same inbound message can arrive more than
  // once. This skips the common case (a retry that lands well after the
  // first delivery finished) before doing any work at all. It is *not*
  // sufficient on its own for near-simultaneous concurrent deliveries --
  // see the atomic `claimInboundMessage` call below, which is the real
  // guard against duplicate side effects.
  if (event.message_handle && (await hasMessageWithHandle(event.message_handle))) {
    req.log.info({ messageHandle: event.message_handle }, "Ignoring duplicate Sendblue webhook delivery");
    res.status(200).json({ received: true });
    return;
  }

  try {
    const isGroup = Boolean(event.group_id);

    let threadId: number;
    let senderUserId: number;

    if (isGroup && event.group_id) {
      const groupId = event.group_id;
      const participantNumbers = event.participants?.length ? event.participants : [event.from_number];
      const { thread, participants } = await findOrCreateGroupThread(groupId, participantNumbers);
      threadId = thread.id;
      const sender =
        participants.find((p) => p.phoneNumber === event.from_number) ??
        (await findOrCreateUser(event.from_number, { source: "group_add", originThreadId: thread.id })).user;
      senderUserId = sender.id;
    } else {
      const { thread, user } = await findOrCreateDirectThread(event.from_number);
      threadId = thread.id;
      senderUserId = user.id;
    }

    // Atomic idempotency guard: claims this delivery by inserting the
    // message row under the unique `sendblueMessageHandle` constraint. If a
    // near-simultaneous retry already won that insert, this returns null --
    // stop here, *before* running any of the group-intro/disclosure side
    // effects below or the agent turn, so a duplicate delivery can never
    // trigger them twice. Messages without a handle (shouldn't happen for
    // real inbound Sendblue events, but keeps this defensive) always fall
    // through and get recorded normally.
    if (event.message_handle) {
      const claimed = await claimInboundMessage({
        threadId,
        userId: senderUserId,
        content: event.content,
        sendblueMessageHandle: event.message_handle,
        rawPayload: event,
      });
      if (!claimed) {
        req.log.info({ messageHandle: event.message_handle }, "Ignoring duplicate Sendblue webhook delivery (race)");
        res.status(200).json({ received: true });
        return;
      }
    } else {
      await recordMessage({
        threadId,
        userId: senderUserId,
        direction: "inbound",
        role: "user",
        content: event.content,
        sendblueMessageHandle: null,
        rawPayload: event,
      });
    }

    // Record first_reply milestone. The unique index makes this idempotent
    // across retries; funnel errors are swallowed inside recordActivationEvent.
    void recordActivationEvent(senderUserId, "first_reply");

    if (isGroup) {
      // One-time, whole-group intro when the concierge is first added to a
      // new group -- said once, ever, regardless of how many people later
      // join. Distinct from the per-person welcome below.
      if (!(await hasGroupBeenIntroduced(threadId))) {
        // Suppress the intro when any participant in this thread has opted out
        // via "forget me". Group iMessage sends cannot be scoped to individual
        // recipients, so the only safe option is to stay silent for the whole
        // group. The thread is still marked introduced so this check doesn't
        // repeat on every subsequent message.
        const hasOptedOut = await threadHasOptedOutParticipant(threadId);
        if (!hasOptedOut) {
          // Context-aware intro: if the group already has messages (the concierge
          // was added mid-flight), read the room and open with something specific.
          // Falls back to the static boilerplate when there's nothing to read.
          const introMessage = await generateGroupIntroMessage(threadId);
          await sendToThread(threadId, introMessage);
        }
        await markGroupIntroduced(threadId);
      }

      // Any participant the concierge doesn't have a profile for yet gets a
      // short one-line welcome in the group -- never a full questionnaire
      // dropped into the group -- plus an optional 1:1 DM where the actual
      // preference-gathering questions happen privately.
      const needingDisclosure = await getParticipantsNeedingDisclosure(threadId);
      for (const person of needingDisclosure) {
        // Cross-thread memory: someone who already has a completed profile
        // from another thread is a known quantity the moment they show up
        // here -- skip re-running the preference questionnaire and just
        // acknowledge that the concierge already knows them.
        const isReturningMember = person.onboardingStatus === "completed";
        await sendToThread(
          threadId,
          isReturningMember
            ? `Hey ${person.displayName ?? "there"}, welcome -- I already know your usual picks, so I'll factor those in.`
            : `Hey ${person.displayName ?? "there"}, welcome -- glad to have you here.`,
        );
        await markDisclosureSent(threadId, person.id);

        if (!isReturningMember && person.phoneNumber) {
          const { thread: dmThread } = await findOrCreateDirectThread(person.phoneNumber);
          // Send contact card first so they can save the number, then the
          // structured intro that kicks off the 3-step onboarding exchange.
          await sendContactCardIfNeeded(person.id, person.phoneNumber);
          await sendToThread(dmThread.id, ONBOARDING.groupDm.intro("the group", privacyPolicyUrl()));
          // Mark in_progress so the webhook routes their reply to the onboarding
          // handler rather than the main LLM agent.
          await db.update(usersTable).set({ onboardingStatus: "in_progress" }).where(eq(usersTable.id, person.id));
        }
      }
    }

    // 1. Deterministic commands that must always work regardless of mute
    // state or LLM behavior: mute/unmute and "what do you know about me".
    const muteCommand = detectMuteCommand(event.content);
    if (muteCommand) {
      await setParticipantMuted(threadId, senderUserId, muteCommand === "mute");
      const privacyUrl = privacyPolicyUrl();
      await sendToThread(
        threadId,
        muteCommand === "mute"
          ? `Got it, I'll go quiet in this thread. Note: if you're added to another group I'm in, I'll introduce myself there too -- that's thread-specific. Text "forget me" to delete all your data and stop future introductions${privacyUrl ? `, or see ${privacyUrl} for full privacy options` : ""}.`
          : "I'm back -- happy to help again.",
      );
      res.status(200).json({ received: true });
      return;
    }

    // 1.25. Support flag: "this is broken", "contact support", "something's wrong", etc.
    // Fires regardless of mute state so ops always see distress signals. Sets the
    // needsAttention flag on the thread and sends a short acknowledgment reply,
    // then continues processing (does not short-circuit the rest of the handler)
    // so the LLM can still respond if the thread is otherwise active.
    if (detectSupportFlag(event.content)) {
      await db
        .update(threadsTable)
        .set({ needsAttention: true, needsAttentionAt: new Date() })
        .where(eq(threadsTable.id, threadId));
      await sendToThread(
        threadId,
        "Got it — flagging this for review. Someone will follow up shortly.",
      );
      res.status(200).json({ received: true });
      return;
    }

    const knowledgeCommand = detectKnowledgeCommand(event.content);
    if (knowledgeCommand) {
      const reply = await handleKnowledgeCommand(senderUserId, knowledgeCommand);
      await sendToThread(threadId, reply);
      res.status(200).json({ received: true });
      return;
    }

    // 1.5. Structured onboarding intercept (1:1 threads only).
    // For users who haven't completed onboarding, route their message through
    // the step-based flow rather than the LLM agent. Mute/knowledge commands
    // above are allowed through so they always work -- everything else during
    // onboarding is an onboarding reply.
    if (!isGroup) {
      const [senderRow] = await db
        .select({ onboardingStatus: usersTable.onboardingStatus, displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, senderUserId));

      if (senderRow && senderRow.onboardingStatus !== "completed") {
        const [profileRow] = await db
          .select({
            budget: profilesTable.budget,
            dietaryNeeds: profilesTable.dietaryNeeds,
            preferences: profilesTable.preferences,
          })
          .from(profilesTable)
          .where(eq(profilesTable.userId, senderUserId));

        const step = getOnboardingStep(senderRow.onboardingStatus, senderRow.displayName, profileRow ?? null);

        if (step !== "complete") {
          // Group-referred users (those who received the groupDm intro) should
          // get group-contextual phrasing for all subsequent steps. Detect this
          // by checking whether the user already belongs to any group thread --
          // if so, they arrived via a group-referral DM, not a cold 1:1 start.
          const userGroupThreads = await getGroupThreadsForUser(senderUserId);
          const onboardingVariant: "directDm" | "groupDm" =
            userGroupThreads.length > 0 ? "groupDm" : "directDm";

          await handleDirectOnboardingStep(
            step,
            senderUserId,
            threadId,
            event.content,
            senderRow.displayName,
            profileRow ?? null,
            event.from_number,
            sendContactCardIfNeeded,
            onboardingVariant,
          );
          res.status(200).json({ received: true });
          return;
        }

        // Profile fields indicate completion but status wasn't flipped yet
        // (can happen if the LLM populated fields before structured onboarding
        // ran). Silently fix it and fall through to the normal agent turn.
        await db
          .update(usersTable)
          .set({ onboardingStatus: "completed" })
          .where(eq(usersTable.id, senderUserId));
        void recordActivationEvent(senderUserId, "onboarding_complete");
        await checkAndSendGroupKickoffRecap(senderUserId);
      }
    }

    // 2. A pending post-plan feedback prompt takes priority over everything
    // else conversational -- if we just asked "how was it?", this reply is
    // almost certainly the answer.
    const [threadRow] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
    if (threadRow?.pendingFeedbackPlanId) {
      const ratingMatch = event.content.trim().match(/^([1-5])\b/);
      const value = ratingMatch
        ? { rating: Number.parseInt(ratingMatch[1] as string, 10) }
        : { text: event.content.trim() };
      await db.insert(feedbackTable).values({
        threadId,
        planId: threadRow.pendingFeedbackPlanId,
        userId: senderUserId,
        kind: ratingMatch ? "rating" : "free_text",
        value,
      });

      // Venue-specific feedback, distinct from the generic plan feedback
      // above -- best-effort matched by the plan's free-text `venue` name
      // against the curated corpus. Nothing consumes this for ranking yet.
      const [feedbackPlan] = await db.select().from(plansTable).where(eq(plansTable.id, threadRow.pendingFeedbackPlanId));
      if (feedbackPlan?.venue) {
        const venueId = await findVenueIdByName(feedbackPlan.venue);
        await recordVenueFeedback({
          venueId,
          threadId,
          planId: feedbackPlan.id,
          userId: senderUserId,
          rating: ratingMatch ? Number.parseInt(ratingMatch[1] as string, 10) : null,
          comment: ratingMatch ? null : event.content.trim(),
        });
      }

      await setPendingFeedback(threadId, null);
      await sendToThread(threadId, "Thanks for the feedback -- noted for next time!");
      res.status(200).json({ received: true });
      return;
    }

    // 2.5. Private aggregation over DM: if this is a 1:1 thread and the
    // sender owes an answer to an open private-input request, this reply is
    // almost certainly that answer, not a normal chat message. Only the
    // combined result (never this raw answer) ever reaches the group.
    if (!isGroup) {
      const openRequest = await getOpenPrivateInputRequestForUser(senderUserId);
      if (openRequest) {
        await recordPrivateInputResponse(openRequest.id, senderUserId, event.content);
        await sendToThread(threadId, "Got it, thanks -- keeping that between us.");

        if (await isPrivateInputComplete(openRequest)) {
          const summary = await aggregatePrivateInput(openRequest);
          await resolvePrivateInputRequest(openRequest.id, summary);
          await sendToThread(openRequest.threadId, summary);
        }

        res.status(200).json({ received: true });
        return;
      }
    }

    // 2.7. Organizer sidebar: if this 1:1 sender is the organizer of an active project,
    // check for pending proposals awaiting approval and for poll tiebreak overrides
    // before falling through to the normal 1:1 engine turn (which runs with injected
    // project context so the LLM can answer project questions naturally).
    if (!isGroup) {
      const organizerProject = await getActiveProjectForOrganizer(senderUserId);
      if (organizerProject) {
        const pendingProposal = await getOldestPendingProposal(organizerProject.id);

        if (pendingProposal) {
          if (isApprovalReply(event.content)) {
            await releasePendingProposalToGroup(pendingProposal, organizerProject.threadId, threadId);
            res.status(200).json({ received: true });
            return;
          }
          if (isRejectionReply(event.content)) {
            await rejectProposal(pendingProposal.id, event.content);
            await sendToThread(
              threadId,
              "Got it -- scrapping that draft. What would you like to change?",
            );
            res.status(200).json({ received: true });
            return;
          }
          // Ambiguous reply: remind the organizer what's pending.
          await sendToThread(
            threadId,
            'Still waiting on your call -- reply "yes" to send it to the group, or tell me what to change.',
          );
          res.status(200).json({ received: true });
          return;
        }

        // No pending proposal -- check for poll tiebreak override ("go with X", "pick the rooftop one").
        if (isTiebreakOverride(event.content)) {
          const openPoll = await getOpenPoll(organizerProject.threadId);
          if (openPoll) {
            const matched = matchOption(event.content, openPoll.options);
            if (matched) {
              // Retrieve the full option to access optionDate (matchOption returns a slimmer type).
              const fullOption = openPoll.options.find((o) => o.id === matched.id);
              await closePollWithWinner(openPoll.poll.id, matched.id);
              if (openPoll.poll.planId) {
                if (openPoll.poll.kind === "date" && fullOption?.optionDate) {
                  await setPlanScheduledFor(openPoll.poll.planId, fullOption.optionDate);
                } else if (openPoll.poll.kind === "choice") {
                  await setPlanVenue(openPoll.poll.planId, matched.label);
                }
              }
              // If this was a destination poll, stamp the project destination.
              const destProject = await getProjectByDestinationPollId(openPoll.poll.id);
              if (destProject) {
                await setProjectDestination(destProject.id, matched.label);
                logger.info(
                  { projectId: destProject.id, destination: matched.label },
                  "Destination locked from organizer tiebreak override",
                );
              }
              await sendToThread(
                organizerProject.threadId,
                destProject
                  ? `Destination locked -- going with ${matched.label}.`
                  : `Decision made -- going with "${matched.label}".`,
                undefined,
                "celebration",
              );
              await sendToThread(threadId, destProject ? `${matched.label} it is -- destination locked!` : `Done -- locked in "${matched.label}" for the group.`);
              res.status(200).json({ received: true });
              return;
            }
          }
        }

        // Fall through: organizer sidebar turn with project context injected.
        // The sidebar turn function skips proposal gating (organizer replies are
        // 1:1, not group-visible) and injects the project into the system prompt.
        scheduleAgentTurn(threadId, senderUserId, event.content, (tid, uid) =>
          processOrganizerSidebarTurn(tid, uid, organizerProject),
        );
        res.status(200).json({ received: true });
        return;
      }
    }

    // 3. If there's an open poll on this thread, check whether this message is a vote.
    const openPoll = await getOpenPoll(threadId);
    if (openPoll) {
      // Tiebreaker persona: if an "executive decision" is currently in its
      // objection window, a deterministic objection cancels the auto-lock
      // rather than being treated as a vote or a normal chat message.
      if (openPoll.poll.tiebreakAnnouncedAt && OBJECTION_PATTERN.test(event.content)) {
        await clearTiebreak(openPoll.poll.id);
        await sendToThread(threadId, "Got it, holding off -- what would you prefer instead?");
        res.status(200).json({ received: true });
        return;
      }

      // Texting UX polish: an iMessage tapback ("Loved \"...\"") on one of
      // the poll's own option bubbles counts as a vote for that option.
      // Only positive reactions (loved/liked/emphasized) register.
      const tapback = parseTapback(event.content);
      const effectiveContent = tapback && tapback.isPositive ? tapback.quotedContent : event.content;
      if (tapback && !tapback.isPositive) {
        res.status(200).json({ received: true });
        return;
      }

      if (openPoll.poll.kind === "date") {
        const matched = matchOptions(effectiveContent, openPoll.options);
        if (matched.length > 0) {
          await recordVotes(openPoll.poll.id, matched.map((m) => m.id), senderUserId);

          // React to the voter's message to acknowledge their vote quietly —
          // avoids pushing a text bubble for every vote in a busy group.
          if (event.message_handle) {
            void sendReaction(event.message_handle, "like");
          }

          const participantRows = await db
            .select()
            .from(threadParticipantsTable)
            .where(eq(threadParticipantsTable.threadId, threadId));
          // isFullIntersection is judged against the whole thread's expected
          // participant count, not just current voters -- otherwise the
          // very first vote would trivially "intersect with itself" and
          // close the poll before anyone else weighs in.
          const winner = await computeDatePollWinner(openPoll.poll.id, openPoll.options, participantRows.length);
          const voterCount = await countDistinctVoters(openPoll.poll.id);

          if (winner && (winner.isFullIntersection || voterCount >= participantRows.length)) {
            await closePollWithWinner(openPoll.poll.id, winner.option.id);
            if (openPoll.poll.planId) {
              const winningOption = openPoll.options.find((o) => o.id === winner.option.id);
              if (winningOption?.optionDate) {
                await setPlanScheduledFor(openPoll.poll.planId, winningOption.optionDate);
              }
            }
            await sendToThread(
              threadId,
              winner.isFullIntersection
                ? `Everyone's free "${winner.option.label}" -- let's lock that in.`
                : `We didn't get a date that works for literally everyone, so going with the best overlap: "${winner.option.label}".`,
              undefined,
              "celebration",
            );
          } else {
            await sendToThread(
              threadId,
              `Got it -- noted (${voterCount}/${participantRows.length} have responded so far).`,
            );
          }
          res.status(200).json({ received: true });
          return;
        }
      } else {
        const matched = matchOption(effectiveContent, openPoll.options);
        if (matched) {
          await recordVote(openPoll.poll.id, matched.id, senderUserId);

          // React to the voter's message quietly — less noise than a text reply.
          if (event.message_handle) {
            void sendReaction(event.message_handle, "like");
          }

          const [tally, voterCount, participantRows, isCommitPoll] = await Promise.all([
            tallyPoll(openPoll.poll.id, openPoll.options),
            countDistinctVoters(openPoll.poll.id),
            db.select().from(threadParticipantsTable).where(eq(threadParticipantsTable.threadId, threadId)),
            // Commitment polls are governed by the deadline scanner, not vote totals.
            // Suppress winner-based auto-close so votes remain editable until lock.
            isCommitmentPoll(openPoll.poll.id),
          ]);

          const tallyLine = tally.map((t) => `${t.option.label}: ${t.voteCount}`).join(", ");

          if (!isCommitPoll && voterCount >= participantRows.length) {
            const winnerTally = [...tally].sort((a, b) => b.voteCount - a.voteCount)[0];
            if (winnerTally) {
              await closePollWithWinner(openPoll.poll.id, winnerTally.option.id);
              if (openPoll.poll.planId) {
                await setPlanVenue(openPoll.poll.planId, winnerTally.option.label);
              }
              // If this was a destination poll, stamp the project destination.
              const destProject = await getProjectByDestinationPollId(openPoll.poll.id);
              if (destProject) {
                await setProjectDestination(destProject.id, winnerTally.option.label);
                logger.info(
                  { projectId: destProject.id, destination: winnerTally.option.label },
                  "Destination locked from poll auto-close",
                );
              }
              await sendToThread(
                threadId,
                destProject
                  ? `${winnerTally.option.label} it is! Destination locked.`
                  : `Everyone's voted! We're going with "${winnerTally.option.label}" (${tallyLine}).`,
                undefined,
                "confetti",
              );
            }
          } else {
            await sendToThread(
              threadId,
              `Got it. Current tally (${voterCount}/${participantRows.length} voted) -- ${tallyLine}`,
            );
          }

          res.status(200).json({ received: true });
          return;
        }
      }
    }

    // 4. If this sender is the designated approver for a pending booking, check for an approval/rejection.
    const pendingBooking = await findPendingBookingForApprover(senderUserId);
    if (pendingBooking) {
      const intent = detectApprovalIntent(event.content);
      if (intent === "approve") {
        // React to the approver's "YES" message with a heart — confirms we
        // received it before the async confirmation work finishes.
        if (event.message_handle) {
          void sendReaction(event.message_handle, "love");
        }

        const booking = await confirmBooking(pendingBooking.id);
        let confirmationSuffix = "";
        let mediaUrl: string | undefined;
        if (booking.planId) {
          const plan = await confirmPlan(booking.planId);
          const googleLink = buildGoogleCalendarLink(plan);
          const icsLink = buildIcsUrl(plan.id);
          // Prefer the .ics link (works natively with Apple Calendar on iPhone);
          // include Google Calendar as a fallback when PUBLIC_API_URL is set.
          const calendarParts = [
            icsLink ? `Add to calendar: ${icsLink}` : googleLink ? `Add to calendar: ${googleLink}` : null,
          ].filter(Boolean);
          confirmationSuffix = ` ${describePlanSchedule(plan)}.${calendarParts.length ? ` ${calendarParts.join(" ")}` : ""}`;
          if (plan.scheduledFor) {
            await scheduleDayBeforeReminder(booking.threadId, plan.id, plan.scheduledFor);
          }

          // Plan cards: a visual confirmation card once the plan is locked in.
          const attendeeRows = await db
            .select({ user: usersTable })
            .from(threadParticipantsTable)
            .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
            .where(eq(threadParticipantsTable.threadId, booking.threadId));
          const attendeeNames = attendeeRows.map((row) => row.user.displayName ?? row.user.phoneNumber);
          mediaUrl = (await buildPlanCardMediaUrl(plan, attendeeNames)) ?? undefined;

          // Cross-thread memory: remember what this group actually did, per
          // person, so the next thread this person is in (even a brand new
          // group) already has real history to draw on -- not just stated
          // preferences.
          if (plan.venue) {
            await Promise.all(attendeeRows.map((row) => recordPastChoice(row.user.id, plan.venue as string)));

            // A confirmed booking is the strongest possible "picked" signal
            // for the venue corpus's recommendation-event log.
            const pickedVenueId = await findVenueIdByName(plan.venue);
            if (pickedVenueId) {
              await markVenuePicked(booking.threadId, pickedVenueId, plan.id);
              // Log "ignored" for all other corpus venues that were shown to
              // this thread during this plan session but not ultimately picked.
              await logIgnoredVenuesForThread(booking.threadId, plan.id, pickedVenueId);
            }
          }
        }

        // Booking deep links: a pre-filled Resy/OpenTable search, framed
        // explicitly as a search, never a guaranteed table.
        const links = buildReservationLinks(booking);
        const linksLine = ` ${describeReservationLinks(links)}`;

        // Plan locked in — celebrate it.
        await sendToThread(booking.threadId, `Confirmed: "${booking.title}".${confirmationSuffix}${linksLine}`, mediaUrl, "celebration");
        if (booking.threadId !== threadId) {
          await sendToThread(threadId, `Thanks -- approved "${booking.title}".`);
        }
        res.status(200).json({ received: true });
        return;
      }
      if (intent === "reject") {
        const booking = await rejectBookingRecord(pendingBooking.id);
        await sendToThread(
          booking.threadId,
          `No problem, I've dropped "${booking.title}". Let me know if you want to plan something else.`,
        );
        if (booking.threadId !== threadId) {
          await sendToThread(threadId, `Got it -- rejected "${booking.title}".`);
        }
        res.status(200).json({ received: true });
        return;
      }
    }

    // 5. Group-chat etiquette: stay silent if this thread is muted for this
    // person, or if the message isn't addressed to the concierge and has no
    // clear planning intent -- a busy group shouldn't get a reply to every
    // message just because the concierge is present.
    if (isGroup) {
      if (await isParticipantMuted(threadId, senderUserId)) {
        req.log.info({ threadId, senderUserId, gate: "muted" }, "Group message suppressed: participant is muted");
        res.status(200).json({ received: true });
        return;
      }
      if (!shouldRespondInGroup(event.content)) {
        // Borderline case: regex says no. If there's an active plan the
        // concierge stays responsive without an extra LLM call. Otherwise
        // run a cheap single-completion intent check so short-form triggers
        // like "drinks?" or "who's around sat?" don't read as the bot ignoring.
        const activePlanForGate = await getActivePlan(threadId);
        if (!activePlanForGate && !(await checkPlanningIntentWithLLM(event.content))) {
          req.log.info(
            { threadId, senderUserId, gate: "regex_rejected_llm_no" },
            "Group message suppressed: regex gate failed, no active plan, LLM confirmed no planning intent",
          );
          res.status(200).json({ received: true });
          return;
        }
        req.log.info(
          { threadId, senderUserId, gate: "regex_rejected_allowed_by_plan_or_llm" },
          "Group message passed etiquette gate via active plan or LLM intent",
        );
      }
    }

    // 6. Otherwise, hand off to the (debounced) main conversation engine and
    // ack immediately -- the reply is delivered asynchronously once the
    // debounce window closes, so a burst of messages only triggers one turn.
    scheduleAgentTurn(threadId, senderUserId, event.content, processAgentTurn);

    res.status(200).json({ received: true });
  } catch (error) {
    req.log.error({ error }, "Failed to process Sendblue webhook event");
    // Always ack the webhook so Sendblue doesn't retry indefinitely.
    res.status(200).json({ received: true });
  }
});

export default router;
