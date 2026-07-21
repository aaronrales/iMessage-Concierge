/**
 * Step-routing logic for the structured first-interaction onboarding flow.
 *
 * Extracted from sendblue.ts so it can be imported directly by tests without
 * pulling in the full webhook handler dependency graph.
 *
 * `handleDirectOnboardingStep` accepts `sendContactCard` as an injected
 * dependency so tests can stub it without mocking the Sendblue API client.
 */

import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ONBOARDING,
  buildPersonalityConfirmation,
  buildPracticalConfirmation,
  extractName,
  extractPersonality,
  extractPractical,
  generateOnboardingReply,
} from "./onboarding";
import { sendToThread } from "./delivery";
import { applyProfileUpdates } from "./engine";
import {
  getGroupThreadsForUser,
  hasOnboardingRecapBeenSent,
  isGroupFullyOnboarded,
  loadThreadContext,
  markOnboardingRecapSent,
} from "./context";
import { recordActivationEvent } from "./activation";

/**
 * Checks whether every group this user belongs to is now fully onboarded and,
 * if so, sends the one-time "everyone's set up" kickoff recap to each such
 * group. Fires at most once per group (guarded by `onboardingRecapSentAt`).
 */
export async function checkAndSendGroupKickoffRecap(userId: number): Promise<void> {
  const groupThreads = await getGroupThreadsForUser(userId);
  for (const groupThread of groupThreads) {
    if (await hasOnboardingRecapBeenSent(groupThread.id)) continue;
    if (!(await isGroupFullyOnboarded(groupThread.id))) continue;

    const recapContext = await loadThreadContext(groupThread.id);
    const recapLines = recapContext.participants
      .map(({ user, profile }) => {
        // Only ever surface public-visibility fields in a group-bound message --
        // same rule `scrubPrivateProfileLeaks` enforces for LLM replies.
        const bits = [
          profile?.preferencesVisibility === "public" && profile.preferences.length
            ? profile.preferences.join(", ")
            : null,
        ].filter((bit): bit is string => Boolean(bit));
        return `${user.displayName ?? "someone"}${bits.length ? ` (${bits.join("; ")})` : ""}`;
      })
      .join(", ");
    await sendToThread(
      groupThread.id,
      `Everyone's set up now -- here's who I know: ${recapLines}. I'll factor all of that in when I plan things for this group.`,
    );
    await markOnboardingRecapSent(groupThread.id);
  }
}

/**
 * Handles one step of the structured onboarding exchange for a 1:1 thread.
 * Returns without calling scheduleAgentTurn — the caller must return early
 * after invoking this so the LLM turn never fires during onboarding.
 *
 * Step 0 (not_started): Send contact card + intro message, mark in_progress.
 * Step 1 (no displayName): Extract name, send practical-constraint question.
 * Step 2 (no practical):   Extract budget/dietary, send personality question.
 * Step 3 (no personality): Extract signal, send completion, mark complete.
 *
 * @param sendContactCard Injectable dependency so the caller can provide the
 *   real implementation or a test stub without coupling this module to the
 *   Sendblue API client.
 * @param variant Controls which message copy is used: "groupDm" for users who
 *   arrived via a group-referral DM, "directDm" (default) for cold 1:1 starts.
 */
export async function handleDirectOnboardingStep(
  step: 0 | 1 | 2 | 3,
  userId: number,
  threadId: number,
  content: string,
  displayName: string | null | undefined,
  profile: { budget: string | null | undefined; dietaryNeeds: string | null | undefined; preferences: string[] | null | undefined } | null,
  phone: string,
  sendContactCard: (userId: number, phone: string) => Promise<void>,
  variant: "directDm" | "groupDm" = "directDm",
): Promise<void> {
  const messages = ONBOARDING[variant];

  if (step === 0) {
    // First-ever message: send contact card then the persona-aware intro.
    await sendContactCard(userId, phone);
    // Compute the template string as the LLM fallback.
    const introFallback = typeof messages.intro === "function"
      ? (messages.intro as (ctx: string) => string)("the group")
      : (messages.intro as string);
    const introText = await generateOnboardingReply({
      step: 0,
      variant,
      incomingMessage: content,
      fallback: introFallback,
    });
    await sendToThread(threadId, introText);
    await db.update(usersTable).set({ onboardingStatus: "in_progress" }).where(eq(usersTable.id, userId));
    return;
  }

  if (step === 1) {
    // Waiting for name.
    const name = await extractName(content);
    if (name) {
      await db.update(usersTable).set({ displayName: name }).where(eq(usersTable.id, userId));
      const reply = await generateOnboardingReply({
        step: 1,
        variant,
        incomingMessage: content,
        extractedName: name,
        fallback: messages.askPractical(name),
      });
      await sendToThread(threadId, reply);
    } else {
      // Extraction failed (ambiguous reply) -- ask once more, gently.
      const reply = await generateOnboardingReply({
        step: 1,
        variant,
        incomingMessage: content,
        extractedName: null,
        fallback: "Sorry, what should I call you?",
      });
      await sendToThread(threadId, reply);
    }
    return;
  }

  if (step === 2) {
    // Waiting for budget/dietary.
    const { budget, dietaryNeeds } = await extractPractical(content);
    if (budget ?? dietaryNeeds) {
      await applyProfileUpdates(userId, {
        ...(budget ? { budget } : {}),
        ...(dietaryNeeds ? { dietaryNeeds } : {}),
      });
    }
    const confirmation = buildPracticalConfirmation(budget, dietaryNeeds);
    const reply = await generateOnboardingReply({
      step: 2,
      variant,
      incomingMessage: content,
      extractedBudget: budget,
      extractedDietaryNeeds: dietaryNeeds,
      fallback: messages.askPersonality(confirmation),
    });
    await sendToThread(threadId, reply);
    return;
  }

  // step === 3: waiting for personality signal.
  const preferences = await extractPersonality(content);
  if (preferences.length) {
    await applyProfileUpdates(userId, { preferences });
  }
  const confirmation = buildPersonalityConfirmation(preferences);
  const reply = await generateOnboardingReply({
    step: 3,
    variant,
    incomingMessage: content,
    extractedPreferences: preferences,
    fallback: messages.complete(confirmation),
  });
  await sendToThread(threadId, reply);
  await db.update(usersTable).set({ onboardingStatus: "completed" }).where(eq(usersTable.id, userId));
  void recordActivationEvent(userId, "onboarding_complete");
  // Fire group kickoff recap in case completing this person finishes the roster.
  await checkAndSendGroupKickoffRecap(userId);
}
