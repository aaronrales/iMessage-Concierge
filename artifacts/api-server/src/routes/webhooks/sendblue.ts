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
  markDisclosureSent,
  markGroupIntroduced,
  threadHasOptedOutParticipant,
  recordMessage,
  setParticipantMuted,
} from "../../lib/agent/context";
import { checkAndSendGroupKickoffRecap, handleDirectOnboardingStep } from "../../lib/agent/onboardingFlow";
import { scheduleAgentTurn } from "../../lib/agent/debounce";
import { processConversationTurn } from "../../lib/agent/turnOrchestrator";
import { sendToThread } from "../../lib/agent/delivery";
import { detectKnowledgeCommand, handleKnowledgeCommand } from "../../lib/agent/knowledge";
import { checkPlanningIntentWithLLM, detectMuteCommand, detectSupportFlag, shouldRespondInGroup } from "../../lib/agent/etiquette";
import { getOnboardingStep, ONBOARDING } from "../../lib/agent/onboarding";
import {
  clearTiebreak,
  closePollWithWinner,
  computeDatePollWinner,
  countDistinctVoters,
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
  findPendingBookingForApprover,
  rejectBookingRecord,
} from "../../lib/agent/bookings";
import { confirmPlan, getActivePlan, setPlanScheduledFor, setPlanVenue, setPendingFeedback } from "../../lib/agent/plans";
import { getActiveProjectForOrganizer } from "../../lib/agent/projects";
import { isCommitmentPoll } from "../../lib/agent/commitmentPoll";
import {
  setProjectDestination,
  getProjectByDestinationPollId,
} from "../../lib/agent/destinationSuggestions";
import {
  getOldestPendingProposal,
  rejectProposal,
  isApprovalReply,
  isRejectionReply,
  isTiebreakOverride,
} from "../../lib/agent/projectProposals";
import { releasePendingProposalToGroup } from "../../lib/agent/proposalRelease";
import { sendContactCardIfNeeded } from "../../lib/agent/contactCard";
import { buildGoogleCalendarLink, buildIcsUrl, describePlanSchedule } from "../../lib/agent/calendar";
import { buildArrivalMatrix, formatArrivalMatrix } from "../../lib/agent/arrivalMatrix";
import { scheduleDayBeforeReminder, enqueueJITExtractionIfNeeded } from "../../lib/agent/scheduler";
import { buildReservationLinks, describeReservationLinks } from "../../lib/agent/bookingLinks";
import { buildPlanCardMediaUrl } from "../../lib/agent/planCard";
import { getNow } from "../../lib/agent/clock";
import { recordPastChoice } from "../../lib/agent/tasteEngine";
import { findVenueIdByName, logIgnoredVenuesForThread, markVenuePicked, recordVenueFeedback } from "../../lib/agent/venueCorpus/recommendationLog";
import {
  aggregatePrivateInput,
  getOpenPrivateInputRequestForUser,
  isPrivateInputComplete,
  recordPrivateInputResponse,
  resolvePrivateInputRequest,
} from "../../lib/agent/privateInput";
import { feedbackTable, db, plansTable, profilesTable, projectsTable, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendReaction } from "../../lib/sendblue";
import { generateGroupIntroMessage } from "../../lib/agent/groupIntro";
import { logger } from "../../lib/logger";
import { recordActivationEvent } from "../../lib/agent/activation";
import { privacyPolicyUrl } from "../../lib/publicUrl";

// ─── ARCHITECTURE NOTE ───────────────────────────────────────────────────────
// Pipeline: parse → dedupe → deterministic commands → etiquette gate → agent turn
//
// This file covers only: webhook parse/validation, idempotency claiming,
// deterministic command handling (mute, support flags, votes, approvals,
// tiebreak replies, feedback, private input), etiquette gates, and dispatch
// into the debounced agent turn. Conversation orchestration lives in
// lib/agent/turnOrchestrator.ts (single spine for group / 1:1 / sidebar
// turns); structured sidebar actions in lib/agent/organizerActions.ts;
// proposal release in lib/agent/proposalRelease.ts.
//
// STANDING RULE: Deterministic command handlers (mute, forget, approvals,
// tiebreak replies, arrival, tapbacks, close-it-out) should migrate to
// lib/agent/commands/ as { matcher, handler } pairs as they are touched.
// Adding a new hardcoded command? Put it in lib/agent/commands/ instead.
// ─────────────────────────────────────────────────────────────────────────────

/** iMessage tapback text on this poll's own announcement bubbles counts as a vote (Phase 2 texting UX polish). */
const OBJECTION_PATTERN = /\b(no|nope|wait|hold on|object|objection|don'?t lock|actually)\b/i;

const router: IRouter = Router();

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
    // TODO: migrate to lib/agent/commands/ registry — see lib/agent/commands/index.ts
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
          // Check if this request is an arrival-collection round for a project.
          // If so, send the structured arrival matrix to the group instead of
          // the generic LLM-aggregated summary — the matrix is more useful.
          const [arrivalProject] = await db
            .select({
              id: projectsTable.id,
              threadId: projectsTable.threadId,
              arrivalCollectionRequestId: projectsTable.arrivalCollectionRequestId,
              organizerUserId: projectsTable.organizerUserId,
            })
            .from(projectsTable)
            .where(eq(projectsTable.arrivalCollectionRequestId, openRequest.id))
            .limit(1);

          if (arrivalProject) {
            try {
              const matrix = await buildArrivalMatrix(arrivalProject);
              if (matrix && matrix.entries.length > 0) {
                const matrixText = formatArrivalMatrix(matrix);
                await resolvePrivateInputRequest(openRequest.id, matrixText);
                await sendToThread(openRequest.threadId, matrixText);
                // Notify the organizer's sidebar too.
                if (arrivalProject.organizerUserId) {
                  const [orgUser] = await db
                    .select({ phoneNumber: usersTable.phoneNumber })
                    .from(usersTable)
                    .where(eq(usersTable.id, arrivalProject.organizerUserId));
                  if (orgUser?.phoneNumber) {
                    const { thread: orgThread } = await findOrCreateDirectThread(orgUser.phoneNumber);
                    await sendToThread(orgThread.id, `All arrival details are in:\n\n${matrixText}`);
                  }
                }
                return;
              }
            } catch (err) {
              logger.warn({ err, projectId: arrivalProject.id }, "Failed to assemble arrival matrix; falling through to generic summary");
            }
          }

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
                // Enqueue JIT venue extraction for the locked destination (non-NYC only).
                await enqueueJITExtractionIfNeeded(matched.label, { threadId: organizerProject.threadId, projectId: destProject.id });
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

        // "Close it out" shortcut: organizer wraps up the project immediately.
        const normalizedContent = event.content.trim();
        if (/\bclose\s+it\s+out\b/i.test(normalizedContent) && organizerProject) {
          const now = getNow();
          await db.update(projectsTable).set({ status: "done", closedAt: now }).where(eq(projectsTable.id, organizerProject.id));
          await sendToThread(threadId, "Got it — wrapping things up! 🎉");
          await sendToThread(organizerProject.threadId, "That's a wrap on " + (organizerProject.honoree ? organizerProject.honoree + "'s " + (organizerProject.type ?? "event") : organizerProject.type ?? "the event") + "! Thanks everyone. 🎉");
          res.status(200).json({ received: true });
          return;
        }

        // Fall through: organizer sidebar turn with project context injected.
        // The sidebar turn skips proposal gating (organizer replies are 1:1,
        // not group-visible) and injects the project into the system prompt.
        scheduleAgentTurn(threadId, senderUserId, event.content, (tid, uid) =>
          processConversationTurn(tid, uid, { sidebarProject: organizerProject }),
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
                // Enqueue JIT venue extraction for the locked destination (non-NYC only).
                await enqueueJITExtractionIfNeeded(winnerTally.option.label, {
                  threadId,
                  projectId: destProject?.id,
                });
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
    scheduleAgentTurn(threadId, senderUserId, event.content, (tid, uid) => processConversationTurn(tid, uid));

    res.status(200).json({ received: true });
  } catch (error) {
    req.log.error({ error }, "Failed to process Sendblue webhook event");
    // Always ack the webhook so Sendblue doesn't retry indefinitely.
    res.status(200).json({ received: true });
  }
});

export default router;
