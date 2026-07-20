import { db, threadParticipantsTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { findOrCreateUser, loadThreadContext, recordMessage } from "./context";
import { applyProfileUpdates, runAgentTurn } from "./engine";
import { sendToThread } from "./delivery";
import { emulatorStorage } from "./emulatorContext";

export interface EmulatorTurnResult {
  messages: Array<{ threadId: number; content: string; mediaUrl?: string }>;
}

export async function runEmulatorTurn(
  threadId: number,
  senderPhone: string,
  content: string,
): Promise<EmulatorTurnResult> {
  const { user: senderUser } = await findOrCreateUser(senderPhone);

  const [existing] = await db
    .select()
    .from(threadParticipantsTable)
    .where(
      and(
        eq(threadParticipantsTable.threadId, threadId),
        eq(threadParticipantsTable.userId, senderUser.id),
      ),
    );

  if (!existing)
    await db.insert(threadParticipantsTable).values({
      threadId,
      userId: senderUser.id,
      role: "user",
    });

  await recordMessage({
    threadId,
    userId: senderUser.id,
    direction: "inbound",
    role: "user",
    content,
  });

  const store = { captured: [] as Array<{ threadId: number; content: string; mediaUrl?: string }> };

  await emulatorStorage.run(store, async () => {
    const context = await loadThreadContext(threadId);
    const result = await runAgentTurn(context, senderUser.id);

    if (result.profileUpdates) await applyProfileUpdates(senderUser.id, result.profileUpdates);
    if (result.displayName)
      await db
        .update(usersTable)
        .set({ displayName: result.displayName })
        .where(eq(usersTable.id, senderUser.id));

    await sendToThread(threadId, result.reply);
  });

  return { messages: store.captured };
}
