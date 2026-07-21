import { db, threadParticipantsTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { findOrCreateUser, loadThreadContext, recordMessage } from "./context";
import { applyProfileUpdates, runAgentTurn } from "./engine";
import { sendToThread } from "./delivery";
import { emulatorStorage } from "./emulatorContext";
import type { VenueCarouselEntry } from "./tools";

export interface EmulatorTurnResult {
  messages: Array<{ threadId: number; content: string; mediaUrl?: string }>;
  /** Venue entries queued for carousel delivery this turn (populated by
   *  search_venues and search_lodging tool calls). Empty array when no tool
   *  was called or when no results were found. */
  venueCarousels: VenueCarouselEntry[];
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

  const store = {
    captured: [] as Array<{ threadId: number; content: string; mediaUrl?: string }>,
    venueCarousels: [] as VenueCarouselEntry[],
  };

  await emulatorStorage.run(store, async () => {
    const context = await loadThreadContext(threadId);
    const result = await runAgentTurn(context, senderUser.id);

    if (result.profileUpdates) await applyProfileUpdates(senderUser.id, result.profileUpdates);
    if (result.displayName)
      await db
        .update(usersTable)
        .set({ displayName: result.displayName })
        .where(eq(usersTable.id, senderUser.id));

    // Capture carousel entries so tests can assert on accumulator state.
    if (result.venueCarousels) store.venueCarousels = result.venueCarousels;

    await sendToThread(threadId, result.reply);
  });

  return { messages: store.captured, venueCarousels: store.venueCarousels };
}
