import { and, eq, ilike, isNull, lte } from "drizzle-orm";
import { db, occasionsTable, type Occasion } from "@workspace/db";

export type OccasionKind = "birthday" | "anniversary" | "visit" | "other";

export interface CaptureOccasionInput {
  threadId: number;
  aboutUserId?: number | null;
  mentionedByUserId?: number | null;
  kind: OccasionKind;
  label: string;
  occasionDate: Date;
}

/** Records a captured occasion mention. Callers should skip past dates entirely rather than calling this. */
export async function captureOccasion(input: CaptureOccasionInput): Promise<Occasion> {
  const [occasion] = await db
    .insert(occasionsTable)
    .values({
      threadId: input.threadId,
      aboutUserId: input.aboutUserId ?? null,
      mentionedByUserId: input.mentionedByUserId ?? null,
      kind: input.kind,
      label: input.label,
      occasionDate: input.occasionDate,
    })
    .returning();
  if (!occasion) throw new Error("Failed to capture occasion");
  return occasion;
}

/**
 * Occasions landing within `windowMs` from now (default ~2 weeks) that
 * haven't been reminded about yet. Excludes ones already in the past --
 * once the window has closed without a reminder going out (e.g. budget kept
 * denying it), there's nothing useful left to proactively say.
 */
export async function getOccasionsDueForReminder(windowMs: number): Promise<Occasion[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() + windowMs);
  const rows = await db
    .select()
    .from(occasionsTable)
    .where(and(isNull(occasionsTable.remindedAt), lte(occasionsTable.occasionDate, cutoff)));
  return rows.filter((occasion) => occasion.occasionDate.getTime() >= now.getTime());
}

export async function markOccasionReminded(occasionId: number): Promise<void> {
  await db.update(occasionsTable).set({ remindedAt: new Date() }).where(eq(occasionsTable.id, occasionId));
}

/**
 * Links any unlinked occasions in this thread that match the project's honoree
 * to the project. This is what makes the occasion-scan skip logic work for
 * name-only matches (where honoreeUserId is null on both sides): once linked,
 * `occasion.projectId !== null` suppresses duplicate reminders.
 *
 * Runs two passes: exact user-ID match (precise), then honoree-name substring
 * match against the occasion label (fuzzy, catches "Sarah's birthday" when
 * honoreeName is "Sarah"). Both are restricted to the project's thread so
 * occasions from unrelated threads are never touched.
 */
export async function linkOccasionsToProject(
  projectId: number,
  threadId: number,
  honoreeUserId: number | null,
  honoreeName: string | null,
): Promise<void> {
  // Pass 1: exact user-ID match.
  if (honoreeUserId !== null) {
    await db
      .update(occasionsTable)
      .set({ projectId })
      .where(
        and(
          eq(occasionsTable.threadId, threadId),
          isNull(occasionsTable.projectId),
          eq(occasionsTable.aboutUserId, honoreeUserId),
        ),
      );
  }
  // Pass 2: honoree name substring match against the occasion label.
  if (honoreeName) {
    await db
      .update(occasionsTable)
      .set({ projectId })
      .where(
        and(
          eq(occasionsTable.threadId, threadId),
          isNull(occasionsTable.projectId),
          ilike(occasionsTable.label, `%${honoreeName}%`),
        ),
      );
  }
}
