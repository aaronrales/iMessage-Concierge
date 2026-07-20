import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { findOrCreateUser, findOrCreateDirectThread, loadThreadContext, recordMessage } from "../lib/agent/context";
import { applyProfileUpdates, runAgentTurn } from "../lib/agent/engine";
import { sendToThread } from "../lib/agent/delivery";
import { emulatorStorage } from "../lib/agent/emulatorContext";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const SendMessageBody = z.object({
  threadId: z.number().int().positive(),
  senderPhone: z.string().min(1),
  content: z.string().min(1),
});

/**
 * POST /emulator/message
 *
 * Injects a message into a thread and runs the agent synchronously,
 * capturing all outbound sends (to this thread and any others) without
 * calling Sendblue. The budget governor is bypassed so emulator calls
 * never consume daily proactive-send limits.
 *
 * Returns the full list of captured outbound messages so the UI can
 * display the agent's reply and any side-effect sends (e.g. payment-request
 * DMs to other threads) in a single response.
 */
router.post("/emulator/message", async (req, res) => {
  const parseResult = SendMessageBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body", details: parseResult.error.flatten() });
    return;
  }

  const { threadId, senderPhone, content } = parseResult.data;

  // Verify the target thread exists.
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  try {
    // Find or create the user represented by the sender phone.
    const { user: senderUser } = await findOrCreateUser(senderPhone);

    // Ensure the sender is a participant of this thread (add them if missing,
    // so the agent context can resolve them as a known participant).
    const [existingParticipant] = await db
      .select()
      .from(threadParticipantsTable)
      .where(
        and(
          eq(threadParticipantsTable.threadId, threadId),
          eq(threadParticipantsTable.userId, senderUser.id),
        ),
      );
    if (!existingParticipant) {
      await db.insert(threadParticipantsTable).values({
        threadId,
        userId: senderUser.id,
        role: "user",
      });
    }

    // Persist the inbound message so the agent's context load picks it up.
    await recordMessage({
      threadId,
      userId: senderUser.id,
      direction: "inbound",
      role: "user",
      content,
    });

    // Run the agent turn inside the emulator storage context so all
    // sendToThread calls are captured instead of going to Sendblue.
    const store = { captured: [] as Array<{ threadId: number; content: string; mediaUrl?: string }> };

    await emulatorStorage.run(store, async () => {
      const context = await loadThreadContext(threadId);
      const result = await runAgentTurn(context, senderUser.id);

      if (result.profileUpdates) {
        await applyProfileUpdates(senderUser.id, result.profileUpdates);
      }
      if (result.displayName) {
        await db
          .update(usersTable)
          .set({ displayName: result.displayName })
          .where(eq(usersTable.id, senderUser.id));
      }

      // Send the reply (captured, not actually sent).
      await sendToThread(threadId, result.reply);
    });

    res.json({ messages: store.captured });
  } catch (error) {
    logger.error({ error, threadId }, "Emulator turn failed");
    res.status(500).json({ error: "Emulator turn failed" });
  }
});

/**
 * GET /emulator/threads
 *
 * Returns a lightweight list of all threads with their participants so the
 * emulator UI can populate the thread selector dropdown.
 */
router.get("/emulator/threads", async (_req, res) => {
  try {
    const threads = await db
      .select({
        id: threadsTable.id,
        isGroup: threadsTable.isGroup,
        title: threadsTable.title,
        primaryPhoneNumber: threadsTable.primaryPhoneNumber,
      })
      .from(threadsTable)
      .orderBy(threadsTable.id);

    // Fetch participants for each thread.
    const participants = await db
      .select({
        threadId: threadParticipantsTable.threadId,
        userId: usersTable.id,
        phoneNumber: usersTable.phoneNumber,
        displayName: usersTable.displayName,
      })
      .from(threadParticipantsTable)
      .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id));

    const participantsByThread = new Map<number, typeof participants>();
    for (const p of participants) {
      const arr = participantsByThread.get(p.threadId) ?? [];
      arr.push(p);
      participantsByThread.set(p.threadId, arr);
    }

    const result = threads.map((t) => ({
      ...t,
      participants: participantsByThread.get(t.id) ?? [],
    }));

    res.json(result);
  } catch (error) {
    logger.error({ error }, "Failed to list threads for emulator");
    res.status(500).json({ error: "Failed to list threads" });
  }
});

export default router;
