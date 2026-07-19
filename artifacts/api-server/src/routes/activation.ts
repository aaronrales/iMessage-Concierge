import { Router, type IRouter } from "express";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db, usersTable, activationEventsTable } from "@workspace/db";
import { GetActivationSummaryResponse } from "@workspace/api-zod";
import { buildActivationSummary } from "../lib/agent/activation";

const router: IRouter = Router();

router.get("/activation-summary", async (req, res): Promise<void> => {
  const rawDays = Number(req.query["windowDays"] ?? 7);
  const windowDays = Number.isFinite(rawDays) && rawDays >= 1 ? Math.floor(rawDays) : 7;

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Users created within the window.
  const recentUsers = await db
    .select({ id: usersTable.id, source: usersTable.source })
    .from(usersTable)
    .where(gte(usersTable.createdAt, since));

  // Cohort-based conversion: which of those users have an onboarding_complete event?
  const completedUserIds = new Set<number>();
  if (recentUsers.length > 0) {
    const cohortIds = recentUsers.map((u) => u.id);
    const completedRows = await db
      .select({ userId: activationEventsTable.userId })
      .from(activationEventsTable)
      .where(
        and(
          inArray(activationEventsTable.userId, cohortIds),
          eq(activationEventsTable.event, "onboarding_complete"),
        ),
      );
    for (const row of completedRows) {
      completedUserIds.add(row.userId);
    }
  }

  const summary = buildActivationSummary(windowDays, recentUsers, completedUserIds);

  res.json(GetActivationSummaryResponse.parse(summary));
});

export default router;
