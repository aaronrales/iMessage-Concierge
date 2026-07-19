import { eq } from "drizzle-orm";
import { db, profilesTable, usersTable, type Profile } from "@workspace/db";

/**
 * Deterministic "what do you know about me?" / "forget ..." commands. Kept
 * outside the LLM's JSON contract on purpose: correction/deletion of stored
 * personal data is a privacy-sensitive path that should never depend on the
 * model choosing to honor it -- a regex match here always wins.
 */

const KNOW_PATTERN = /what (do|did) you know about me\b|what have you (learned|stored) about me\b/i;
const FORGET_ALL_PATTERN = /\b(forget everything about me|clear my profile)\b/i;
/**
 * "Forget me" / "delete my data" — stronger than forget_all. Deletes the
 * profile row entirely and scrubs the user row, then sends a farewell.
 * Matched before FORGET_ALL_PATTERN so it wins on overlapping phrases.
 */
const FORGET_ME_PATTERN =
  /\b(forget me|delete (my|all) (data|info(rmation)?)|remove (my|all) (data|info(rmation)?)|(erase|wipe) (me|my data))\b/i;
const FORGET_FIELD_PATTERN =
  /\bforget (my )?(budget|dietary needs|dietary|preferences|notes)\b/i;

export type KnowledgeCommand =
  | { type: "show" }
  | { type: "forget_me" }
  | { type: "forget_all" }
  | { type: "forget_field"; field: "budget" | "dietaryNeeds" | "preferences" | "notes" };

export function detectKnowledgeCommand(content: string): KnowledgeCommand | null {
  const normalized = content.trim();
  if (KNOW_PATTERN.test(normalized)) return { type: "show" };
  // forget_me checked first — it's a superset of forget_all intent.
  if (FORGET_ME_PATTERN.test(normalized)) return { type: "forget_me" };
  if (FORGET_ALL_PATTERN.test(normalized)) return { type: "forget_all" };

  const fieldMatch = normalized.match(FORGET_FIELD_PATTERN);
  if (fieldMatch) {
    const rawField = fieldMatch[2]?.toLowerCase();
    const field =
      rawField === "budget"
        ? "budget"
        : rawField?.startsWith("dietary")
          ? "dietaryNeeds"
          : rawField === "preferences"
            ? "preferences"
            : "notes";
    return { type: "forget_field", field };
  }

  return null;
}

function describeProfile(profile: Profile | undefined): string {
  if (!profile) return "I don't have anything stored about you yet.";

  const bits = [
    profile.budget ? `Budget: ${profile.budget}` : null,
    profile.dietaryNeeds ? `Dietary needs: ${profile.dietaryNeeds}` : null,
    profile.preferences?.length ? `Preferences: ${profile.preferences.join(", ")}` : null,
    profile.notes ? `Notes: ${profile.notes}` : null,
  ].filter((line): line is string => Boolean(line));

  if (bits.length === 0) return "I don't have anything stored about you yet.";
  return `Here's what I have on you:\n${bits.join("\n")}\nJust say \"forget my <thing>\" or \"forget everything about me\" any time to have me drop it.`;
}

export async function handleKnowledgeCommand(userId: number, command: KnowledgeCommand): Promise<string> {
  const [profile] = await db.select().from(profilesTable).where(eq(profilesTable.userId, userId));

  switch (command.type) {
    case "show":
      return describeProfile(profile);

    case "forget_me":
      // Deletes the profile row (cascades automatically) and scrubs the user
      // row. The user row is kept for referential integrity (messages,
      // thread_participants, activation_events all reference users.id), but
      // all personally-identifying fields are nulled out and doNotContact is
      // set so no proactive outreach (group intros, disclosure DMs, onboarding
      // nudges) is ever sent to this number again. The user can reactivate by
      // texting the concierge directly.
      await db.delete(profilesTable).where(eq(profilesTable.userId, userId));
      await db
        .update(usersTable)
        .set({ displayName: null, doNotContact: true })
        .where(eq(usersTable.id, userId));
      return (
        "Done -- I've deleted your profile and everything I had stored about you. " +
        "I won't introduce myself or send you any messages proactively going forward, " +
        "even if you're added to another group I'm in. " +
        "If you ever want to use the concierge again, just text me directly and I'll start fresh. " +
        "To block all messages entirely, reply STOP."
      );

    case "forget_all":
      await db
        .update(profilesTable)
        .set({ budget: null, dietaryNeeds: null, preferences: [], notes: null })
        .where(eq(profilesTable.userId, userId));
      return "Done -- I've cleared everything I had stored about you.";

    case "forget_field": {
      const set =
        command.field === "preferences"
          ? { preferences: [] as string[] }
          : { [command.field]: null };
      await db.update(profilesTable).set(set).where(eq(profilesTable.userId, userId));
      return `Done -- I've forgotten your ${command.field === "dietaryNeeds" ? "dietary needs" : command.field}.`;
    }
  }
}
