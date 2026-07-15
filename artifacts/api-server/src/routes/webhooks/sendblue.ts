import { Router, type IRouter } from "express";
import { ReceiveSendblueWebhookBody, ReceiveSendblueWebhookParams } from "@workspace/api-zod";
import { logger } from "../../lib/logger";
import { sendDirectMessage, sendGroupMessage } from "../../lib/sendblue";
import {
  findOrCreateDirectThread,
  findOrCreateGroupThread,
  findOrCreateUser,
  loadThreadContext,
  recordMessage,
} from "../../lib/agent/context";
import { applyProfileUpdates, runAgentTurn } from "../../lib/agent/engine";
import { scheduleAgentTurn } from "../../lib/agent/debounce";
import { scrubPrivateProfileLeaks } from "../../lib/agent/privacy";
import {
  closePollWithWinner,
  countDistinctVoters,
  createPoll,
  getOpenPoll,
  matchOption,
  recordVote,
  tallyPoll,
} from "../../lib/agent/polls";
import {
  confirmBooking,
  detectApprovalIntent,
  draftBooking,
  findPendingBookingForApprover,
  rejectBookingRecord,
} from "../../lib/agent/bookings";
import { db, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

/**
 * Sends a message into a thread. The transport (group vs direct, and which
 * phone/group id to use) is always looked up from the target thread's own DB
 * record, never taken from the caller -- a booking approval reply can arrive
 * on a different thread than the one it needs to notify, so the two must
 * never be conflated.
 */
async function sendToThread(threadId: number, content: string): Promise<void> {
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));

  try {
    if (thread?.isGroup && thread.sendblueGroupId) {
      await sendGroupMessage({ groupId: thread.sendblueGroupId, content });
    } else if (thread?.primaryPhoneNumber) {
      await sendDirectMessage({ to: thread.primaryPhoneNumber, content });
    } else {
      logger.warn({ threadId }, "Cannot send outbound message: thread has no known transport");
    }
  } catch (error) {
    logger.error({ error, threadId }, "Failed to send outbound Sendblue message");
  }

  await recordMessage({ threadId, userId: null, direction: "outbound", role: "assistant", content });
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
  }

  if (result.poll && isGroup) {
    await createPoll(threadId, result.poll.question, result.poll.options);
  }

  if (result.bookingDraft) {
    const approverPhone = result.bookingDraft.approverPhoneNumber;
    const approver = approverPhone ? await findOrCreateUser(approverPhone) : { id: senderUserId };
    const booking = await draftBooking({
      threadId,
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
    let groupId: string | null = null;
    let directPhoneNumber: string | null = null;

    if (isGroup && event.group_id) {
      groupId = event.group_id;
      const participantNumbers = event.participants?.length ? event.participants : [event.from_number];
      const { thread, participants } = await findOrCreateGroupThread(groupId, participantNumbers);
      threadId = thread.id;
      const sender = participants.find((p) => p.phoneNumber === event.from_number) ?? (await findOrCreateUser(event.from_number));
      senderUserId = sender.id;
    } else {
      directPhoneNumber = event.from_number;
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

    // 1. If there's an open poll on this thread, check whether this message is a vote.
    const openPoll = await getOpenPoll(threadId);
    if (openPoll) {
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
          const winner = [...tally].sort((a, b) => b.voteCount - a.voteCount)[0];
          if (winner) {
            await closePollWithWinner(openPoll.poll.id, winner.option.id);
            await sendToThread(
              threadId,
              `Everyone's voted! We're going with "${winner.option.label}" (${tallyLine}).`,
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

    // 2. If this sender is the designated approver for a pending booking, check for an approval/rejection.
    const pendingBooking = await findPendingBookingForApprover(senderUserId);
    if (pendingBooking) {
      const intent = detectApprovalIntent(event.content);
      if (intent === "approve") {
        const booking = await confirmBooking(pendingBooking.id);
        await sendToThread(
          booking.threadId,
          `Confirmed: "${booking.title}". I'll follow up here once it's actually locked in with the venue.`,
        );
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

    // 3. Otherwise, hand off to the (debounced) main conversation engine and
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
