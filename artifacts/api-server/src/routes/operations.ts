import { Router, type IRouter } from "express";
import { and, desc, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db, llmCostLogTable, messageDeliveryLogTable, threadsTable, toolCallLogTable } from "@workspace/db";
import { GetDeliveryHealthQueryParams, GetDeliveryHealthResponse } from "@workspace/api-zod";

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
  const query = GetDeliveryHealthQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const windowHours = Math.floor(query.data.windowHours);

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

/**
 * GET /api/cost-summary
 * Returns LLM cost totals for the last 7 days.
 */
router.get("/api/cost-summary", async (_req, res): Promise<void> => {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Total cost in last 7 days
  const [totalRow] = await db
    .select({ totalCents: sql<number>`coalesce(sum(${llmCostLogTable.estimatedCostCents}), 0)` })
    .from(llmCostLogTable)
    .where(gte(llmCostLogTable.createdAt, since7d));
  const totalCents7d = Number(totalRow?.totalCents ?? 0);

  // Cost per day (last 7 days)
  const perDayRows = await db
    .select({
      day: sql<string>`date_trunc('day', ${llmCostLogTable.createdAt})::text`,
      cents: sql<number>`coalesce(sum(${llmCostLogTable.estimatedCostCents}), 0)`,
    })
    .from(llmCostLogTable)
    .where(gte(llmCostLogTable.createdAt, since7d))
    .groupBy(sql`date_trunc('day', ${llmCostLogTable.createdAt})`)
    .orderBy(sql`date_trunc('day', ${llmCostLogTable.createdAt})`);
  const costPerDay = perDayRows.map((r) => ({ day: r.day, cents: Number(r.cents) }));

  // Top threads by cost
  const topThreadRows = await db
    .select({
      threadId: llmCostLogTable.threadId,
      totalCents: sql<number>`coalesce(sum(${llmCostLogTable.estimatedCostCents}), 0)`,
    })
    .from(llmCostLogTable)
    .where(and(gte(llmCostLogTable.createdAt, since7d), isNotNull(llmCostLogTable.threadId)))
    .groupBy(llmCostLogTable.threadId)
    .orderBy(desc(sql`sum(${llmCostLogTable.estimatedCostCents})`))
    .limit(5);

  // Resolve thread titles
  const threadIds = topThreadRows.map((r) => r.threadId).filter((id): id is number => id !== null);
  const titleMap = new Map<number, string | null>();
  if (threadIds.length > 0) {
    const threadRows = await db
      .select({ id: threadsTable.id, title: threadsTable.title, primaryPhoneNumber: threadsTable.primaryPhoneNumber })
      .from(threadsTable)
      .where(inArray(threadsTable.id, threadIds));
    for (const t of threadRows) {
      titleMap.set(t.id, t.title ?? t.primaryPhoneNumber ?? null);
    }
  }

  const topThreads = topThreadRows.map((r) => ({
    threadId: r.threadId,
    threadTitle: r.threadId !== null ? (titleMap.get(r.threadId) ?? null) : null,
    totalCents: Number(r.totalCents),
  }));

  res.json({ totalCents7d, costPerDay, topThreads });
});

/**
 * GET /operations/tool-health
 * Per-tool outcome summary for the last 24 h, plus a 7-day daily series
 * for sparkline rendering in the dashboard.
 */
router.get("/operations/tool-health", async (req, res): Promise<void> => {
  const rawHours = Number(req.query["windowHours"] ?? 24);
  const windowHours =
    Number.isFinite(rawHours) && rawHours >= 1 && rawHours <= 168
      ? Math.floor(rawHours)
      : 24;

  const since24h = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Per-tool aggregates over the window.
  const aggRows = await db
    .select({
      toolName: toolCallLogTable.toolName,
      outcome: toolCallLogTable.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(toolCallLogTable)
    .where(gte(toolCallLogTable.createdAt, since24h))
    .groupBy(toolCallLogTable.toolName, toolCallLogTable.outcome);

  // Last-seen outcome per tool.
  const lastRows = await db
    .select({
      toolName: toolCallLogTable.toolName,
      outcome: toolCallLogTable.outcome,
      createdAt: toolCallLogTable.createdAt,
    })
    .from(toolCallLogTable)
    .where(gte(toolCallLogTable.createdAt, since24h))
    .orderBy(desc(toolCallLogTable.createdAt))
    .limit(200); // enough to cover all tools; we pick the first per tool below

  // 7-day daily series per tool.
  const sparkRows = await db
    .select({
      toolName: toolCallLogTable.toolName,
      day: sql<string>`date_trunc('day', ${toolCallLogTable.createdAt})::text`,
      outcome: toolCallLogTable.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(toolCallLogTable)
    .where(gte(toolCallLogTable.createdAt, since7d))
    .groupBy(
      toolCallLogTable.toolName,
      sql`date_trunc('day', ${toolCallLogTable.createdAt})`,
      toolCallLogTable.outcome,
    )
    .orderBy(sql`date_trunc('day', ${toolCallLogTable.createdAt})`);

  // --- Aggregate into per-tool summaries ---
  const SUCCESS_OUTCOMES = new Set(["success"]);

  // Map: toolName → { totalCalls, successCalls, outcomeCounts }
  const toolMap = new Map<string, { total: number; success: number; outcomeCounts: Record<string, number> }>();
  for (const row of aggRows) {
    const entry = toolMap.get(row.toolName) ?? { total: 0, success: 0, outcomeCounts: {} };
    entry.total += Number(row.count);
    if (SUCCESS_OUTCOMES.has(row.outcome)) entry.success += Number(row.count);
    entry.outcomeCounts[row.outcome] = (entry.outcomeCounts[row.outcome] ?? 0) + Number(row.count);
    toolMap.set(row.toolName, entry);
  }

  // Map: toolName → lastOutcome
  const lastOutcomeMap = new Map<string, string>();
  for (const row of lastRows) {
    if (!lastOutcomeMap.has(row.toolName)) lastOutcomeMap.set(row.toolName, row.outcome);
  }

  // Map: toolName → day → { success, total }
  type DayEntry = { success: number; total: number };
  const sparkMap = new Map<string, Map<string, DayEntry>>();
  for (const row of sparkRows) {
    if (!sparkMap.has(row.toolName)) sparkMap.set(row.toolName, new Map());
    const dayMap = sparkMap.get(row.toolName)!;
    const entry = dayMap.get(row.day) ?? { success: 0, total: 0 };
    entry.total += Number(row.count);
    if (SUCCESS_OUTCOMES.has(row.outcome)) entry.success += Number(row.count);
    dayMap.set(row.day, entry);
  }

  const byTool = [...toolMap.entries()].map(([toolName, { total, success, outcomeCounts }]) => {
    const rate = total === 0 ? null : Math.round((success / total) * 1000) / 10;
    const dayMap = sparkMap.get(toolName) ?? new Map();
    const sparkline = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, { success: s, total: t }]) => ({
        day,
        successRate: t === 0 ? null : Math.round((s / t) * 1000) / 10,
        calls: t,
      }));

    return {
      toolName,
      calls: total,
      successCalls: success,
      successRate: rate,
      outcomeCounts,
      lastOutcome: lastOutcomeMap.get(toolName) ?? null,
      sparkline,
    };
  });

  res.json({ windowHours, byTool });
});

export default router;
