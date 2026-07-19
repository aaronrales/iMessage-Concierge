import { Router, type IRouter } from "express";
import { and, gte, inArray, isNotNull } from "drizzle-orm";
import { db, messageDeliveryLogTable, threadsTable } from "@workspace/db";
import { GetDeliveryHealthResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/** Statuses that count as a completed delivery attempt (success or failure). */
const TERMINAL_STATUSES = ["DELIVERED", "SENT", "ERROR", "FAILED"] as const;
/** Statuses that count as successful. */
const SUCCESS_STATUSES = ["DELIVERED", "SENT"] as const;

function successRate(success: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((success / total) * 1000) / 10;
}

/**
 * GET /operations/delivery-health
 * Rolling delivery health rollup for the last N hours (default 24).
 * Only DELIVERED/SENT/ERROR/FAILED rows count toward rates;
 * BLOCKED (compliance) and QUEUED (in-flight) are excluded.
 */
router.get("/operations/delivery-health", async (req, res): Promise<void> => {
  const rawHours = Number(req.query["windowHours"] ?? 24);
  const windowHours =
    Number.isFinite(rawHours) && rawHours >= 1 && rawHours <= 168
      ? Math.floor(rawHours)
      : 24;

  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // Fetch terminal-status rows for the window.
  const rows = await db
    .select({
      threadId: messageDeliveryLogTable.threadId,
      status: messageDeliveryLogTable.status,
    })
    .from(messageDeliveryLogTable)
    .where(
      and(
        gte(messageDeliveryLogTable.createdAt, since),
        inArray(messageDeliveryLogTable.status, [...TERMINAL_STATUSES]),
      ),
    );

  // Aggregate totals.
  let totalSent = 0;
  let successCount = 0;

  // Per-thread accumulators: threadId → { sent, success }
  const threadMap = new Map<number, { sent: number; success: number }>();

  for (const row of rows) {
    totalSent += 1;
    const isSuccess = (SUCCESS_STATUSES as readonly string[]).includes(row.status);
    if (isSuccess) successCount += 1;

    if (row.threadId !== null) {
      const existing = threadMap.get(row.threadId) ?? { sent: 0, success: 0 };
      existing.sent += 1;
      if (isSuccess) existing.success += 1;
      threadMap.set(row.threadId, existing);
    }
  }

  // Resolve thread titles for all referenced thread ids.
  const threadIds = [...threadMap.keys()];
  const titleMap = new Map<number, string | null>();

  if (threadIds.length > 0) {
    const threadRows = await db
      .select({
        id: threadsTable.id,
        title: threadsTable.title,
        primaryPhoneNumber: threadsTable.primaryPhoneNumber,
      })
      .from(threadsTable)
      .where(inArray(threadsTable.id, threadIds));

    for (const t of threadRows) {
      titleMap.set(t.id, t.title ?? t.primaryPhoneNumber ?? null);
    }
  }

  // Build per-thread breakdown sorted worst-first (lowest successRate first).
  const byThread = [...threadMap.entries()]
    .map(([threadId, { sent, success }]) => ({
      threadId,
      threadTitle: titleMap.get(threadId) ?? null,
      sentCount: sent,
      successCount: success,
      successRate: successRate(success, sent),
    }))
    .sort((a, b) => {
      // null rates (0 sent) go last; lower rates sort first.
      if (a.successRate === null && b.successRate === null) return 0;
      if (a.successRate === null) return 1;
      if (b.successRate === null) return -1;
      return a.successRate - b.successRate;
    });

  const summary = {
    windowHours,
    totalSent,
    successCount,
    successRate: successRate(successCount, totalSent),
    byThread,
  };

  res.json(GetDeliveryHealthResponse.parse(summary));
});

export default router;
