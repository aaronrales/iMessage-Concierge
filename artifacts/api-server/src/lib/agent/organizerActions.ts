import { db, projectsTable, usersTable, type Project } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AgentTurnResult } from "./engine";
import { findOrCreateDirectThread } from "./context";
import { sendToThread } from "./delivery";
import {
  recordEstimates,
  recordPayment,
  recordCommitment,
  findThreadMemberByName,
  getProjectMemberIds,
  buildPaymentRequestMessage,
  getLedgerBalances,
  markRequestSent,
} from "./ledger";
import { buildLodgingLinks, buildLodgingGroupMessage } from "./lodgingLinks";
import { createActionItem, closeActionItem, findMemberByNameInThread } from "./actionItems";
import { createCommitmentPoll, COMMITMENT_IN_LABEL, COMMITMENT_OUT_LABEL } from "./commitmentPoll";
import { getActiveProject } from "./projects";
import { recomputeDueDates } from "./projectTimeline";
import { logger } from "../logger";

/**
 * Structured-action handlers for the organizer's private sidebar turn.
 * Each handler applies one action kind the engine may set on a sidebar turn
 * (ledger, lodging, task, commitment round, project correction). They are
 * pure side-effect appliers: DB writes + message sends, no LLM calls.
 */
export async function applyOrganizerActions(
  result: AgentTurnResult,
  organizerProject: Project,
  senderUserId: number,
): Promise<void> {
  // ── Ledger action handling ─────────────────────────────────────────────────
  if (result.ledgerAction) {
    const action = result.ledgerAction;
    const groupThreadId = organizerProject.threadId;

    if (action.kind === "estimate") {
      // Compute per-person amount.
      let perPersonCents: number | null = action.perPersonCents;
      if (!perPersonCents && action.totalCents && action.headcount && action.headcount > 0) {
        perPersonCents = Math.round(action.totalCents / action.headcount);
      }

      if (perPersonCents && perPersonCents > 0) {
        // Create one estimate row per group member (excluding organizer).
        const memberIds = await getProjectMemberIds(groupThreadId, senderUserId);
        const entries = await recordEstimates(organizerProject.id, memberIds, perPersonCents, action.note);

        // Load organizer info for payment request messages.
        const [organizer] = await db
          .select({ displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
          .from(usersTable)
          .where(eq(usersTable.id, senderUserId));

        // Send payment-request DMs to each member 1:1.
        for (const entry of entries) {
          if (!entry.userId) continue;
          try {
            const [member] = await db
              .select({ displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
              .from(usersTable)
              .where(eq(usersTable.id, entry.userId));
            if (!member?.phoneNumber) continue;

            const { thread: memberThread } = await findOrCreateDirectThread(member.phoneNumber);
            const msg = buildPaymentRequestMessage(
              member.displayName ?? member.phoneNumber,
              perPersonCents,
              action.note,
              organizer?.displayName ?? "the organizer",
              organizer?.phoneNumber ?? null,
            );
            await sendToThread(memberThread.id, msg);
            await markRequestSent(entry.id);
          } catch (err) {
            logger.error({ err, userId: entry.userId }, "Failed to send payment request DM; continuing");
          }
        }
      }
    } else if (action.kind === "payment_recorded") {
      if (action.memberName) {
        const member = await findThreadMemberByName(groupThreadId, action.memberName);
        if (member) {
          // If no amount specified, use their full outstanding estimate balance.
          let amountCents = action.amountCents;
          if (!amountCents) {
            const balances = await getLedgerBalances(organizerProject.id);
            const b = balances.find((bl) => bl.userId === member.userId);
            amountCents = b?.outstandingCents ?? 0;
          }
          if (amountCents > 0) {
            await recordPayment(organizerProject.id, member.userId, amountCents, action.note);
            logger.info(
              { projectId: organizerProject.id, userId: member.userId, amountCents },
              "Payment recorded via organizer sidebar",
            );
          }
        } else {
          logger.warn(
            { projectId: organizerProject.id, memberName: action.memberName },
            "Could not resolve member name for payment recording",
          );
        }
      }
    } else if (action.kind === "commitment") {
      if (action.memberName) {
        const member = await findThreadMemberByName(groupThreadId, action.memberName);
        if (member) {
          await recordCommitment(organizerProject.id, member.userId, action.note);
        }
      }
    }
  }

  // ── Lodging action handling ───────────────────────────────────────────────
  // When the organizer reports a lodging cost, build search deep links for
  // Airbnb/VRBO/Hotels.com and send a per-person split message to the group.
  // The ledger estimate is expected to be handled via the separate ledgerAction
  // field the engine sets alongside this one.
  if (result.lodgingAction) {
    const action = result.lodgingAction;
    const groupThreadId = organizerProject.threadId;

    // Compute per-person amount.
    let perPersonCents = action.perPersonCents;
    if (!perPersonCents && action.totalCents && action.headcount && action.headcount > 0) {
      perPersonCents = Math.round(action.totalCents / action.headcount);
    }

    // Persist per-person cost and property details on the project so the
    // dashboard and context prompt can display them. Property name and dates
    // are the most-needed facts on travel day, so they must survive beyond chat.
    if (perPersonCents && perPersonCents > 0) {
      try {
        await db
          .update(projectsTable)
          .set({
            lodgingPerPersonCents: perPersonCents,
            ...(action.propertyName ? { lodgingPropertyName: action.propertyName } : {}),
            ...(action.checkIn ? { lodgingCheckIn: new Date(action.checkIn) } : {}),
            ...(action.checkOut ? { lodgingCheckOut: new Date(action.checkOut) } : {}),
          })
          .where(eq(projectsTable.id, organizerProject.id));
      } catch (err) {
        logger.warn({ err, projectId: organizerProject.id }, "Failed to store lodging fields; continuing");
      }
    }

    // Build lodging search links using the project's destination + date range.
    // If the organizer provided check-in/out dates in their message, prefer those.
    const checkIn = action.checkIn ? new Date(action.checkIn) : organizerProject.dateRangeStart;
    const checkOut = action.checkOut ? new Date(action.checkOut) : organizerProject.dateRangeEnd;
    const destination = organizerProject.destination ?? "the destination";
    const guests = action.headcount ?? 8; // fall back to a reasonable default

    const links = buildLodgingLinks({ destination, checkIn, checkOut, guests });

    // Build night count for display.
    let nights = action.nights;
    if (!nights && checkIn && checkOut) {
      nights = Math.round((checkOut.getTime() - checkIn.getTime()) / (24 * 60 * 60 * 1000));
    }

    const groupMsg = buildLodgingGroupMessage({
      links,
      destination,
      propertyName: action.propertyName,
      perPersonCents,
      totalCents: action.totalCents,
      headcount: action.headcount,
      nights,
    });

    try {
      await sendToThread(groupThreadId, groupMsg);
      logger.info({ projectId: organizerProject.id, perPersonCents, destination }, "Lodging group message sent");
    } catch (err) {
      logger.error({ err, projectId: organizerProject.id }, "Failed to send lodging group message");
    }
  }

  // ── Task action handling ────────────────────────────────────────────────────
  if (result.taskAction) {
    const action = result.taskAction;
    const groupThreadId = organizerProject.threadId;

    if (action.kind === "create") {
      // Resolve owner by name if provided.
      let ownerUserId: number | null = null;
      if (action.ownerName) {
        const member = await findMemberByNameInThread(groupThreadId, action.ownerName);
        ownerUserId = member?.userId ?? null;
        if (!ownerUserId) {
          logger.warn({ projectId: organizerProject.id, ownerName: action.ownerName }, "Could not resolve action item owner by name");
        }
      }
      await createActionItem(organizerProject.id, action.title, ownerUserId, action.dueDate);
    } else if (action.kind === "close") {
      const closed = await closeActionItem(organizerProject.id, action.title);
      if (!closed) {
        logger.warn({ projectId: organizerProject.id, title: action.title }, "No matching open action item found to close");
      }
    }
  }

  // ── Commitment action handling ─────────────────────────────────────────────
  if (result.commitmentAction) {
    const action = result.commitmentAction;
    const groupThreadId = organizerProject.threadId;
    try {
      const pollId = await createCommitmentPoll(
        organizerProject.id,
        groupThreadId,
        action.deadline,
        action.headcountTarget,
      );

      // Announce the commitment round to the group thread.
      const deadlineStr = action.deadline.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      });
      const targetLine = action.headcountTarget ? ` (target: ${action.headcountTarget} people)` : "";
      await sendToThread(
        groupThreadId,
        `Are you in for the trip?${targetLine} Reply by ${deadlineStr}.\n1. ${COMMITMENT_IN_LABEL}\n2. ${COMMITMENT_OUT_LABEL}`,
      );

      logger.info({ projectId: organizerProject.id, pollId, deadline: action.deadline }, "Commitment round opened via organizer sidebar");
    } catch (err) {
      logger.error({ err, projectId: organizerProject.id }, "Failed to create commitment poll");
    }
  }

  // ── Project correction handling (B1) ──────────────────────────────────────
  // Deliberately restricted to the organizer sidebar so no single group member
  // can silently change structural facts (dates, honoree) that affect everyone.
  if (result.projectCorrectionAction) {
    const action = result.projectCorrectionAction;
    const patch: Partial<typeof projectsTable.$inferInsert> = {};
    if (action.dateRangeStart) patch.dateRangeStart = action.dateRangeStart;
    if (action.dateRangeEnd) patch.dateRangeEnd = action.dateRangeEnd;
    if (action.honoree) patch.honoree = action.honoree;
    if (Object.keys(patch).length > 0) {
      try {
        await db
          .update(projectsTable)
          .set(patch)
          .where(eq(projectsTable.id, organizerProject.id));
        // Recompute timeline due dates whenever dates change.
        if (action.dateRangeStart || action.dateRangeEnd) {
          const updated = await getActiveProject(organizerProject.threadId);
          if (updated) await recomputeDueDates(updated);
        }
        logger.info(
          { projectId: organizerProject.id, patch },
          "Project structural facts corrected via organizer sidebar",
        );
      } catch (err) {
        logger.error({ err, projectId: organizerProject.id }, "Failed to apply project correction; continuing");
      }
    }
  }
}
