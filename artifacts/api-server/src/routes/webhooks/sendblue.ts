import { Router, type IRouter } from "express";
import { ReceiveSendblueWebhookBody } from "@workspace/api-zod";
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

router.post("/webhooks/sendblue", async (req, res): Promise<void> => {
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
          isGroup,
          groupId,
          booking.threadId === threadId ? directPhoneNumber : null,
          `Confirmed: "${booking.title}". I'll follow up here once it's actually locked in with the venue.`,
        );
        if (booking.threadId !== threadId) {
          await sendToThread(threadId, isGroup, groupId, directPhoneNumber, `Thanks -- approved "${booking.title}".`);
        }
        res.status(200).json({ received: true });
        return;
      }
      if (intent === "reject") {
        const booking = await rejectBookingRecord(pendingBooking.id);
        await sendToThread(
          booking.threadId,
          isGroup,
          groupId,
          booking.threadId === threadId ? directPhoneNumber : null,
          `No problem, I've dropped "${booking.title}". Let me know if you want to plan something else.`,
        );
        if (booking.threadId !== threadId) {
          await sendToThread(threadId, isGroup, groupId, directPhoneNumber, `Got it -- rejected "${booking.title}".`);
        }
        res.status(200).json({ received: true });
        return;
      }
    }

    // 3. Otherwise, run the main conversation engine.
    const context = await loadThreadContext(threadId);
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
          false,
          null,
          approverPhone,
          `Heads up -- can you approve this booking: "${booking.title}"? Reply YES to confirm or NO to skip it.`,
        );
      }
    }

    await sendToThread(threadId, isGroup, groupId, directPhoneNumber, result.reply);

    res.status(200).json({ received: true });
  } catch (error) {
    req.log.error({ error }, "Failed to process Sendblue webhook event");
    // Always ack the webhook so Sendblue doesn't retry indefinitely.
    res.status(200).json({ received: true });
  }
});

export default router;
