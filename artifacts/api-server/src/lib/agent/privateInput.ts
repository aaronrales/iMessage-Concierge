import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  privateInputRequestsTable,
  privateInputResponsesTable,
  threadParticipantsTable,
  type PrivateInputRequest,
} from "@workspace/db";
import { openai, CHAT_MODEL } from "../openaiClient";
import { logger } from "../logger";

/**
 * Private aggregation over DM: collects sensitive input from each group
 * member 1:1 (e.g. "what's a realistic amount to chip in?") and only ever
 * surfaces the combined result to the group -- individual answers never
 * leave this module.
 */

export async function createPrivateInputRequest(
  threadId: number,
  planId: number | null,
  question: string,
): Promise<PrivateInputRequest> {
  const [request] = await db
    .insert(privateInputRequestsTable)
    .values({ threadId, planId, question })
    .returning();
  if (!request) throw new Error("Failed to create private input request");
  return request;
}

/**
 * The most recent unresolved private-input request this user owes an answer
 * to, if any. Only one open request is tracked per user at a time -- if a
 * second one is created before the first resolves, the newer one takes
 * priority so a DM reply always has an unambiguous target.
 */
export async function getOpenPrivateInputRequestForUser(userId: number): Promise<PrivateInputRequest | null> {
  const rows = await db
    .select({ request: privateInputRequestsTable })
    .from(privateInputRequestsTable)
    .innerJoin(threadParticipantsTable, eq(threadParticipantsTable.threadId, privateInputRequestsTable.threadId))
    .where(and(eq(threadParticipantsTable.userId, userId), isNull(privateInputRequestsTable.resolvedAt)))
    .orderBy(privateInputRequestsTable.createdAt);

  // Skip anyone who already answered this particular request.
  for (const row of rows.reverse()) {
    const [existingAnswer] = await db
      .select()
      .from(privateInputResponsesTable)
      .where(and(eq(privateInputResponsesTable.requestId, row.request.id), eq(privateInputResponsesTable.userId, userId)));
    if (!existingAnswer) return row.request;
  }
  return null;
}

export async function recordPrivateInputResponse(requestId: number, userId: number, answer: string): Promise<void> {
  await db.insert(privateInputResponsesTable).values({ requestId, userId, answer });
}

async function countExpectedParticipants(threadId: number): Promise<number> {
  const rows = await db
    .select({ userId: threadParticipantsTable.userId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, threadId));
  return rows.length;
}

async function countAnswers(requestId: number): Promise<number> {
  const rows = await db.select().from(privateInputResponsesTable).where(eq(privateInputResponsesTable.requestId, requestId));
  return rows.length;
}

/** Whether enough participants have answered to close out and aggregate this request. */
export async function isPrivateInputComplete(request: PrivateInputRequest): Promise<boolean> {
  const [expected, answered] = await Promise.all([
    countExpectedParticipants(request.threadId),
    countAnswers(request.id),
  ]);
  return answered >= expected && expected > 0;
}

/**
 * Combines every individual answer into a single anonymized summary via one
 * LLM call, explicitly instructed never to attribute an answer to a person
 * or reveal how many people gave which answer -- only the group-usable
 * takeaway. Falls back to a generic line if the completion fails, so a
 * flaky call never leaks raw answers as a fallback.
 */
export async function aggregatePrivateInput(request: PrivateInputRequest): Promise<string> {
  const rows = await db
    .select({ answer: privateInputResponsesTable.answer })
    .from(privateInputResponsesTable)
    .where(eq(privateInputResponsesTable.requestId, request.id));

  const answers = rows.map((r) => r.answer);
  if (answers.length === 0) return "Didn't hear back from anyone in time.";

  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "You combine anonymous 1:1 answers to a group question into ONE short summary sentence usable in a group chat. Never mention how many people answered, never quote an individual answer verbatim, never imply who said what. If answers are numbers (like budget amounts), summarize as a range or total as appropriate to the question. Reply with just the sentence, no quotes, no preamble.",
        },
        {
          role: "user",
          content: `Question asked privately: "${request.question}"\nAnonymous answers:\n${answers.map((a) => `- ${a}`).join("\n")}`,
        },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text || "Got everyone's input -- ready to move forward.";
  } catch (error) {
    logger.error({ error, requestId: request.id }, "Failed to aggregate private input via LLM");
    return "Got everyone's input -- ready to move forward.";
  }
}

export async function resolvePrivateInputRequest(requestId: number, aggregateSummary: string): Promise<void> {
  await db
    .update(privateInputRequestsTable)
    .set({ resolvedAt: new Date(), aggregateSummary })
    .where(eq(privateInputRequestsTable.id, requestId));
}
