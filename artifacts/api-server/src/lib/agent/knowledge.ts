import { eq } from "drizzle-orm";
import { db, profilesTable, type Profile } from "@workspace/db";

/**
 * Deterministic "what do you know about me?" / "forget ..." commands. Kept
 * outside the LLM's JSON contract on purpose: correction/deletion of stored
 * personal data is a privacy-sensitive path that should never depend on the
 * model choosing to honor it -- a regex match here always wins.
 */

const KNOW_PATTERN = /what (do|did) you know about me\b|what have you (learned|stored) about me\b/i;
const FORGET_ALL_PATTERN = /\b(forget everything about me|delete (my|all) (data|info(rmation)?)|clear my profile)\b/i;
const FORGET_FIELD_PATTERN =
  /\bforget (my )?(budget|dietary needs|dietary|preferences|notes)\b/i;

export type KnowledgeCommand =
  | { type: "show" }
  | { type: "forget_all" }
  | { type: "forget_field"; field: "budget" | "dietaryNeeds" | "preferences" | "notes" };

export function detectKnowledgeCommand(content: string): KnowledgeCommand | null {
  const normalized = content.trim();
  if (KNOW_PATTERN.test(normalized)) return { type: "show" };
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
