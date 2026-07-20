/**
 * Arrival-detail collection and matrix assembly for trip projects.
 *
 * Uses the existing private-input rail to DM each group participant and ask
 * for their arrival info (flight + time, or driving ETA). Once collected (or
 * a deadline passes), `assembleArrivalMatrix` produces a clean group summary
 * sorted by stated arrival time.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  privateInputRequestsTable,
  privateInputResponsesTable,
  projectsTable,
  threadParticipantsTable,
  usersTable,
} from "@workspace/db";
import { createPrivateInputRequest } from "./privateInput";
import { logger } from "../logger";

const ARRIVAL_QUESTION =
  "What are your arrival details for the trip? Share your flight number and arrival time if flying, or when you expect to arrive if driving.";

// ── Collection round ──────────────────────────────────────────────────────────

/**
 * Creates a private-input request for arrival details and records its ID on
 * the project so the dashboard can display response progress.
 *
 * Re-calling this function opens a fresh round — it replaces the stored
 * request ID, and group members will receive the question again even if they
 * already answered a previous round. This lets the organizer collect updated
 * info after itinerary changes.
 *
 * @returns The new private-input request ID.
 */
export async function startArrivalCollection(
  projectId: number,
  groupThreadId: number,
): Promise<number> {
  const request = await createPrivateInputRequest(groupThreadId, null, ARRIVAL_QUESTION);

  await db
    .update(projectsTable)
    .set({ arrivalCollectionRequestId: request.id })
    .where(eq(projectsTable.id, projectId));

  logger.info({ projectId, requestId: request.id, groupThreadId }, "Arrival collection round started");
  return request.id;
}

// ── Response status ───────────────────────────────────────────────────────────

export interface ArrivalResponseStatus {
  requestId: number;
  respondedCount: number;
  totalCount: number;
}

/**
 * Returns how many participants have responded to the arrival-collection
 * request for a project. Returns null when no collection round is active.
 */
export async function getArrivalResponseStatus(project: {
  id: number;
  arrivalCollectionRequestId: number | null;
  threadId: number;
}): Promise<ArrivalResponseStatus | null> {
  if (!project.arrivalCollectionRequestId) return null;

  const [responses, participants] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(privateInputResponsesTable)
      .where(eq(privateInputResponsesTable.requestId, project.arrivalCollectionRequestId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(threadParticipantsTable)
      .where(eq(threadParticipantsTable.threadId, project.threadId)),
  ]);

  return {
    requestId: project.arrivalCollectionRequestId,
    respondedCount: responses[0]?.count ?? 0,
    totalCount: participants[0]?.count ?? 0,
  };
}

// ── Matrix assembly ───────────────────────────────────────────────────────────

export interface ArrivalEntry {
  displayName: string | null;
  phoneNumber: string;
  answer: string;
}

export interface ArrivalMatrix {
  entries: ArrivalEntry[];
  respondedCount: number;
  totalCount: number;
}

/**
 * Reads all responses for the active arrival-collection round and returns a
 * structured matrix. Entries are ordered by insertion time (earliest
 * responder first) since we can't reliably parse and sort arbitrary arrival
 * strings without an LLM call.
 */
export async function buildArrivalMatrix(
  project: {
    id: number;
    arrivalCollectionRequestId: number | null;
    threadId: number;
  },
): Promise<ArrivalMatrix | null> {
  if (!project.arrivalCollectionRequestId) return null;

  const responses = await db
    .select({
      userId: privateInputResponsesTable.userId,
      answer: privateInputResponsesTable.answer,
    })
    .from(privateInputResponsesTable)
    .where(eq(privateInputResponsesTable.requestId, project.arrivalCollectionRequestId))
    .orderBy(privateInputResponsesTable.createdAt);

  if (responses.length === 0) return null;

  // Fetch participant count for the denominator.
  const [participantRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, project.threadId));

  const totalCount = participantRow?.count ?? 0;

  // Load user display names in one query.
  const userIds = responses.map((r) => r.userId);
  const users =
    userIds.length > 0
      ? await db
          .select({ id: usersTable.id, displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
          .from(usersTable)
          .where(sql`${usersTable.id} = ANY(ARRAY[${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}]::int[])`)
      : [];

  const userMap = new Map(users.map((u) => [u.id, u]));

  const entries: ArrivalEntry[] = responses.map((r) => {
    const user = userMap.get(r.userId);
    return {
      displayName: user?.displayName ?? null,
      phoneNumber: user?.phoneNumber ?? r.userId.toString(),
      answer: r.answer,
    };
  });

  return { entries, respondedCount: entries.length, totalCount };
}

/**
 * Formats an arrival matrix into a group-ready text summary.
 * Example:
 *   Arrival details (5/8 responded):
 *   Sarah: Delta 1234, lands Sat 2pm
 *   Mike: driving, arriving Friday evening
 *   …
 */
export function formatArrivalMatrix(matrix: ArrivalMatrix): string {
  const header = `Arrival details (${matrix.respondedCount}/${matrix.totalCount} responded):`;
  const lines = matrix.entries.map((e) => {
    const name = e.displayName ?? e.phoneNumber;
    return `${name}: ${e.answer}`;
  });
  return [header, ...lines].join("\n");
}
