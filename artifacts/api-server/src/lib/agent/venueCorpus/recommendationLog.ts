import { and, eq, inArray } from "drizzle-orm";
import { db, recommendationEventsTable, venueFeedbackTable, venuesTable } from "@workspace/db";

/**
 * Every recommendation shown to a group gets logged here, even though
 * nothing consumes this data for ranking yet (see `firstPartyWeight` in
 * `constants.ts`) -- this is the outcome data the BRD wants laid down now so
 * weights can eventually be fit against it.
 */
export async function logRecommendationEvent(params: {
  venueId: number | null;
  threadId: number;
  planId?: number | null;
  outcome: "shown" | "picked" | "ignored" | "rejected";
  context?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(recommendationEventsTable).values({
    venueId: params.venueId,
    threadId: params.threadId,
    planId: params.planId ?? null,
    outcome: params.outcome,
    context: params.context ?? {},
  });
}

/** Marks the most recent "shown" event for a venue in a thread as "picked" -- called once a plan actually locks in that venue. */
export async function markVenuePicked(threadId: number, venueId: number, planId: number | null): Promise<void> {
  await logRecommendationEvent({ venueId, threadId, planId, outcome: "picked" });
}

/** Post-plan venue-specific feedback, distinct from the generic plan feedback table. */
export async function recordVenueFeedback(params: {
  venueId: number | null;
  threadId: number;
  planId?: number | null;
  userId?: number | null;
  rating?: number | null;
  comment?: string | null;
}): Promise<void> {
  if (params.venueId === null) return; // nothing venue-specific to log if we don't know which corpus venue this was
  await db.insert(venueFeedbackTable).values({
    venueId: params.venueId,
    threadId: params.threadId,
    planId: params.planId ?? null,
    userId: params.userId ?? null,
    rating: params.rating ?? null,
    comment: params.comment ?? null,
  });
}

/**
 * Logs an `ignored` outcome for every venue that was `shown` to a thread for
 * a plan but was NOT the one ultimately picked. Call this right after
 * `markVenuePicked` so the corpus recommendation log has a complete picture
 * of each session's shown-but-passed-over candidates.
 *
 * Silently skips if `pickedVenueId` is null (unrecognized venue) -- there's
 * no authoritative signal in that case.
 */
export async function logIgnoredVenuesForThread(threadId: number, planId: number | null, pickedVenueId: number | null): Promise<void> {
  if (pickedVenueId === null) return;

  // Find every venue that was shown in this thread for this plan.
  const shownRows = await db
    .select({ venueId: recommendationEventsTable.venueId })
    .from(recommendationEventsTable)
    .where(
      and(
        eq(recommendationEventsTable.threadId, threadId),
        eq(recommendationEventsTable.outcome, "shown"),
        planId !== null ? eq(recommendationEventsTable.planId, planId) : undefined,
      ),
    );

  const ignoredVenueIds = [
    ...new Set(
      shownRows
        .map((r) => r.venueId)
        .filter((id): id is number => id !== null && id !== pickedVenueId),
    ),
  ];

  if (ignoredVenueIds.length === 0) return;

  // Filter out any that already have a non-shown event (e.g. a previous pick),
  // so we don't double-log a venue that was picked in an earlier session.
  const alreadyActedOn = await db
    .select({ venueId: recommendationEventsTable.venueId })
    .from(recommendationEventsTable)
    .where(
      and(
        eq(recommendationEventsTable.threadId, threadId),
        inArray(recommendationEventsTable.venueId, ignoredVenueIds),
        inArray(recommendationEventsTable.outcome, ["picked", "ignored", "rejected"]),
      ),
    );
  const alreadyActedOnIds = new Set(alreadyActedOn.map((r) => r.venueId));
  const toLog = ignoredVenueIds.filter((id) => !alreadyActedOnIds.has(id));

  if (toLog.length === 0) return;

  await db.insert(recommendationEventsTable).values(
    toLog.map((venueId) => ({
      venueId,
      threadId,
      planId: planId ?? null,
      outcome: "ignored" as const,
      context: {},
    })),
  );
}

/** Best-effort venue-name -> corpus id lookup, e.g. to attach feedback/picked events to a plan's free-text `venue` string. */
export async function findVenueIdByName(name: string, neighborhood?: string): Promise<number | null> {
  const rows = await db.select({ id: venuesTable.id, name: venuesTable.name, neighborhood: venuesTable.neighborhood }).from(venuesTable);
  const normalized = name.trim().toLowerCase();
  const match = rows.find(
    (row) => row.name.trim().toLowerCase() === normalized && (!neighborhood || row.neighborhood.toLowerCase().includes(neighborhood.toLowerCase())),
  );
  return match?.id ?? null;
}
