import { Router, type IRouter } from "express";
import { ReceiveSendblueWebhookBody, ReceiveSendblueWebhookParams } from "@workspace/api-zod";
import {
  findOrCreateDirectThread,
  findOrCreateGroupThread,
  findOrCreateUser,
  getParticipantsNeedingDisclosure,
  isParticipantMuted,
  loadThreadContext,
  markDisclosureSent,
  recordMessage,
  setParticipantMuted,
} from "../../lib/agent/context";
import { applyProfileUpdates, runAgentTurn } from "../../lib/agent/engine";
import { scheduleAgentTurn } from "../../lib/agent/debounce";
import { scrubPrivateProfileLeaks } from "../../lib/agent/privacy";
import { sendToThread } from "../../lib/agent/delivery";
import { detectKnowledgeCommand, handleKnowledgeCommand } from "../../lib/agent/knowledge";
import { detectMuteCommand, shouldRespondInGroup } from "../../lib/agent/etiquette";
import {
  closePollWithWinner,
  computeDatePollWinner,
  countDistinctVoters,
  createPoll,
  getOpenPoll,
  matchOption,
  matchOptions,
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
import { confirmPlan, getOrCreateActivePlan, setPlanScheduledFor, setPlanVenue, setPendingFeedback } from "../../lib/agent/plans";
import { buildGoogleCalendarLink, describePlanSchedule } from "../../lib/agent/calendar";
import { scheduleDayBeforeReminder, scheduleNonVoterNudge } from "../../lib/agent/scheduler";
import { feedbackTable, db, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

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
  }

  if (result.poll && isGroup) {
    const plan = await getOrCreateActivePlan(threadId, result.poll.question);
    const { poll } = await createPoll(threadId, result.poll.question, result.poll.options, {
      kind: result.poll.kind,
      planId: plan.id,
      optionDates: result.poll.optionDates,
    });
    if (result.poll.kind === "date") {
      await scheduleNonVoterNudge(threadId, poll.id);
    }
  }

  if (result.bookingDraft) {
    const approverPhone = result.bookingDraft.approverPhoneNumber;
    const approver = approverPhone ? await findOrCreateUser(approverPhone) : { id: senderUserId };
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

  // Preference privacy enforcement: private profile fields may have silently
  // shaped this reply, but they must never surface verbatim in group-visible
  // text. 1:1 threads skip this -- there's nothing to leak the info to.
  const outgoingReply = isGroup ? scrubPrivateProfileLeaks(result.reply, context.participants) : result.reply;

  await sendToThread(threadId, outgoingReply);
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

  try {
    const isGroup = Boolean(event.group_id);

    let threadId: number;
    let senderUserId: number;

    if (isGroup && event.group_id) {
      const groupId = event.group_id;
      const participantNumbers = event.participants?.length ? event.participants : [event.from_number];
      const { thread, participants } = await findOrCreateGroupThread(groupId, participantNumbers);
      threadId = thread.id;
      const sender = participants.find((p) => p.phoneNumber === event.from_number) ?? (await findOrCreateUser(event.from_number));
      senderUserId = sender.id;

      // One-time onboarding disclosure for any participant who has never
      // seen it -- sent into the group so everyone present sees it, not just
      // the new member.
      const needingDisclosure = await getParticipantsNeedingDisclosure(threadId);
      for (const person of needingDisclosure) {
        await sendToThread(
          threadId,
          `Hi ${person.displayName ?? "there"} -- I'm this group's AI concierge. I help plan things here (polls, bookings, reminders). Say "what do you know about me?" any time to see what I've learned, or "mute you" to have me stay quiet.`,
        );
        await markDisclosureSent(threadId, person.id);
      }
    } else {
      const { thread, user } = await findOrCreateDirectThread(event.from_number);
      threadId = thread.id;
      senderUserId = user.id;
    }

    await recordMessage({
      threadId,
      userId: senderUserId,
      direction: "inbound",
      role: "user",
      content: event.content,
      sendblueMessageHandle: event.message_handle ?? null,
      rawPayload: event,
    });

    // 1. Deterministic commands that must always work regardless of mute
    // state or LLM behavior: mute/unmute and "what do you know about me".
    const muteCommand = detectMuteCommand(event.content);
    if (muteCommand) {
      await setParticipantMuted(threadId, senderUserId, muteCommand === "mute");
      await sendToThread(
        threadId,
        muteCommand === "mute" ? "Got it, I'll stay quiet in here until you unmute me." : "I'm back -- happy to help again.",
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
      await setPendingFeedback(threadId, null);
      await sendToThread(threadId, "Thanks for the feedback -- noted for next time!");
      res.status(200).json({ received: true });
      return;
    }

    // 3. If there's an open poll on this thread, check whether this message is a vote.
    const openPoll = await getOpenPoll(threadId);
    if (openPoll) {
      if (openPoll.poll.kind === "date") {
        const matched = matchOptions(event.content, openPoll.options);
        if (matched.length > 0) {
          await recordVotes(openPoll.poll.id, matched.map((m) => m.id), senderUserId);
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
        const matched = matchOption(event.content, openPoll.options);
        if (matched) {
          await recordVote(openPoll.poll.id, matched.id, senderUserId);
          const tally = await tallyPoll(openPoll.poll.id, openPoll.options);
          const voterCount = await countDistinctVoters(openPoll.poll.id);
          const participantRows = await db
            .select()
            .from(threadParticipantsTable)
            .where(eq(threadParticipantsTable.threadId, threadId));

          const tallyLine = tally.map((t) => `${t.option.label}: ${t.voteCount}`).join(", ");

          if (voterCount >= participantRows.length) {
            const winnerTally = [...tally].sort((a, b) => b.voteCount - a.voteCount)[0];
            if (winnerTally) {
              await closePollWithWinner(openPoll.poll.id, winnerTally.option.id);
              if (openPoll.poll.planId) {
                await setPlanVenue(openPoll.poll.planId, winnerTally.option.label);
              }
              await sendToThread(
                threadId,
                `Everyone's voted! We're going with "${winnerTally.option.label}" (${tallyLine}).`,
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
        const booking = await confirmBooking(pendingBooking.id);
        let confirmationSuffix = "";
        if (booking.planId) {
          const plan = await confirmPlan(booking.planId);
          const link = buildGoogleCalendarLink(plan);
          confirmationSuffix = ` ${describePlanSchedule(plan)}.${link ? ` Add it to your calendar: ${link}` : ""}`;
          if (plan.scheduledFor) {
            await scheduleDayBeforeReminder(booking.threadId, plan.id, plan.scheduledFor);
          }
        }
        await sendToThread(booking.threadId, `Confirmed: "${booking.title}".${confirmationSuffix}`);
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
        res.status(200).json({ received: true });
        return;
      }
      if (!shouldRespondInGroup(event.content)) {
        res.status(200).json({ received: true });
        return;
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
