/**
 * Activation funnel tracking: who entered (users.source), and which
 * lifecycle milestones they've hit (activation_events rows).
 *
 * Milestones are once-per-user by definition, enforced by the unique
 * (userId, event) index -- so `recordActivationEvent` is safe to call
 * unconditionally from hot paths (every inbound message records
 * `first_reply`; only the first call inserts a row).
 */

import { activationEventsTable, db, type ActivationEvent } from "@workspace/db";
import { logger } from "../logger";

/**
 * Records a lifecycle milestone for a user, idempotently. Never throws:
 * funnel bookkeeping must not be able to break message processing, so
 * failures are logged and swallowed.
 */
export async function recordActivationEvent(userId: number, event: ActivationEvent): Promise<void> {
  try {
    await db
      .insert(activationEventsTable)
      .values({ userId, event })
      .onConflictDoNothing({ target: [activationEventsTable.userId, activationEventsTable.event] });
  } catch (error) {
    logger.warn({ error, userId, event }, "Failed to record activation event");
  }
}

// ---------------------------------------------------------------------------
// Summary aggregation (pure -- unit tested)
// ---------------------------------------------------------------------------

export interface ActivationSummary {
  windowDays: number;
  totalInvites: number;
  bySource: {
    coldDm: number;
    groupAdd: number;
    /** Users with a null/unrecognized source (legacy rows, booking approvers). */
    other: number;
  };
  onboardingCompleted: number;
  /** Percent 0-100, rounded to one decimal. Null when there were no invites. */
  conversionRate: number | null;
}

/**
 * Pure aggregation over the window's new users. `completedUserIds` must be
 * the set of users *among these rows* with an `onboarding_complete` event --
 * conversion is cohort-based (of the people invited this window, how many
 * finished onboarding), not a ratio of two unrelated totals.
 */
export function buildActivationSummary(
  windowDays: number,
  recentUsers: { id: number; source: string | null }[],
  completedUserIds: ReadonlySet<number>,
): ActivationSummary {
  const bySource = { coldDm: 0, groupAdd: 0, other: 0 };
  let onboardingCompleted = 0;

  for (const user of recentUsers) {
    if (user.source === "cold_dm") bySource.coldDm += 1;
    else if (user.source === "group_add") bySource.groupAdd += 1;
    else bySource.other += 1;

    if (completedUserIds.has(user.id)) onboardingCompleted += 1;
  }

  const totalInvites = recentUsers.length;
  const conversionRate =
    totalInvites === 0 ? null : Math.round((onboardingCompleted / totalInvites) * 1000) / 10;

  return { windowDays, totalInvites, bySource, onboardingCompleted, conversionRate };
}
