import { logger } from "../logger";
import type { ThreadParticipantContext } from "./context";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Values short enough that redacting them would do more harm (false positives) than good. */
const MIN_REDACTABLE_LENGTH = 3;

function collectPrivateValues(participant: ThreadParticipantContext): string[] {
  const { profile } = participant;
  if (!profile) return [];

  const values: string[] = [];
  if (profile.budgetVisibility === "private" && profile.budget) values.push(profile.budget);
  if (profile.dietaryNeedsVisibility === "private" && profile.dietaryNeeds) values.push(profile.dietaryNeeds);
  if (profile.notesVisibility === "private" && profile.notes) values.push(profile.notes);
  if (profile.preferencesVisibility === "private") values.push(...profile.preferences);

  return values.filter((value) => value.trim().length >= MIN_REDACTABLE_LENGTH);
}

/**
 * Last line of defense for the preference privacy model: private profile
 * fields are always available to the agent so they can silently shape a
 * recommendation, but they must never appear verbatim in a group-visible
 * reply. Call this on every outbound group-thread message before sending.
 *
 * This is a substring-level safety net, not the primary control -- the
 * primary control is prompting the model to reason about constraints without
 * disclosing them (see Phase 3's constraint-satisfaction work). This catches
 * the leaks that get through anyway.
 */
export function scrubPrivateProfileLeaks(reply: string, participants: ThreadParticipantContext[]): string {
  let scrubbed = reply;

  for (const participant of participants) {
    const privateValues = collectPrivateValues(participant);
    for (const value of privateValues) {
      const pattern = new RegExp(escapeRegExp(value), "gi");
      if (pattern.test(scrubbed)) {
        logger.warn(
          { userId: participant.user.id },
          "Redacted a private profile value that leaked into a group-bound reply",
        );
        scrubbed = scrubbed.replace(pattern, "[redacted]");
      }
    }
  }

  return scrubbed;
}
