import { and, eq, isNull, lte } from "drizzle-orm";
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
