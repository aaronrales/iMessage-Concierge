import { describe, expect, it } from "vitest";
import { resolveParticipantsFromContacts } from "../lib/agent/context";

/**
 * Unit tests for the pure participant-resolution logic.
 * The DB wrapper (`resolveGroupParticipants`) is covered by the
 * contact-map-building logic; these tests focus on the invariants:
 *
 * 1. Explicit phones always flow through, even for users not in the DB.
 * 2. Ambiguous display names are never auto-resolved.
 * 3. Unknown names are only flagged when explicit phones don't cover the gap.
 */

describe("resolveParticipantsFromContacts", () => {
  it("uses an explicit phone even when the named participant is not in contacts", () => {
    // User said "start a group with Amy (+15551234567)". LLM gives both a
    // name and an explicit phone. Amy isn't in the DB yet, so the contact
    // map is empty -- but her phone should still be returned.
    const result = resolveParticipantsFromContacts(
      ["Amy"],
      ["+15551234567"],
      new Map(), // no contacts known
    );

    expect(result.resolvedPhones).toContain("+15551234567");
    expect(result.unknownNames).toHaveLength(0);
    expect(result.ambiguousNames).toHaveLength(0);
  });

  it("does not auto-resolve a name that matches multiple contacts", () => {
    // Two different users named "Alex" are in the sender's threads. Picking
    // either one arbitrarily would be a privacy violation, so both result in
    // an ambiguous flag rather than an auto-resolved phone.
    const contacts = new Map<string, string | null>([
      ["alex", null], // null = ambiguous (two "Alex" contacts)
    ]);

    const result = resolveParticipantsFromContacts(["Alex"], [], contacts);

    expect(result.ambiguousNames).toContain("Alex");
    expect(result.resolvedPhones).toHaveLength(0);
    expect(result.unknownNames).toHaveLength(0);
  });

  it("creates the group with known participants and flags only the uncovered unknowns", () => {
    // "Start a group with Amy and Jake": Amy is a known contact, Jake is not.
    // We should resolve Amy's phone and flag Jake — not block the whole request.
    const contacts = new Map<string, string | null>([
      ["amy", "+19990001111"],
    ]);

    const result = resolveParticipantsFromContacts(["Amy", "Jake"], [], contacts);

    expect(result.resolvedPhones).toContain("+19990001111");
    expect(result.unknownNames).toContain("Jake");
    expect(result.ambiguousNames).toHaveLength(0);
  });

  it("does not flag names as unknown when explicit phones already cover all participants", () => {
    // LLM provides explicit phones for both participants. No name lookup needed.
    const result = resolveParticipantsFromContacts(
      ["Amy", "Jake"],
      ["+15551111111", "+15552222222"],
      new Map(), // empty contacts — shouldn't matter
    );

    expect(result.resolvedPhones).toHaveLength(2);
    expect(result.unknownNames).toHaveLength(0);
    expect(result.ambiguousNames).toHaveLength(0);
  });

  it("deduplicates phones when name lookup resolves to an already-explicit number", () => {
    // Explicit phone and name lookup both point to the same person.
    const contacts = new Map<string, string | null>([
      ["amy", "+15551234567"],
    ]);

    const result = resolveParticipantsFromContacts(
      ["Amy"],
      ["+15551234567"],
      contacts,
    );

    expect(result.resolvedPhones).toHaveLength(1);
    expect(result.resolvedPhones[0]).toBe("+15551234567");
  });

  it("does not falsely flag ambiguous when the same contact appears via multiple shared threads", () => {
    // Before the dedup fix, the same person appearing in 3 shared threads
    // would produce 3 rows with the same (name, phone) and mark them as
    // ambiguous on the 2nd occurrence. After dedup-by-phone in the DB
    // wrapper, the map contains exactly one entry for Amy — not null.
    // This test verifies the pure function handles that correctly-built map.
    const contacts = new Map<string, string | null>([
      ["amy", "+11111111111"], // deduplicated — single real person
    ]);
    const result = resolveParticipantsFromContacts(["Amy"], [], contacts);
    expect(result.resolvedPhones).toContain("+11111111111");
    expect(result.ambiguousNames).toHaveLength(0);
    expect(result.unknownNames).toHaveLength(0);
  });

  it("handles a mix: one known, one ambiguous, one unknown with enough explicit phones", () => {
    // "Start a group with Amy, Alex, and Jake"
    // Amy → known contact (+1111)
    // Alex → ambiguous (two contacts named Alex)
    // Jake → not in contacts, BUT there's an explicit phone that covers the gap
    const contacts = new Map<string, string | null>([
      ["amy", "+11111111111"],
      ["alex", null], // ambiguous
    ]);

    const result = resolveParticipantsFromContacts(
      ["Amy", "Alex", "Jake"],
      ["+13333333333"], // explicit phone covers Jake
      contacts,
    );

    expect(result.resolvedPhones).toContain("+11111111111");
    expect(result.resolvedPhones).toContain("+13333333333");
    expect(result.ambiguousNames).toContain("Alex");
    // Jake's gap is covered by the explicit phone — not flagged unknown
    expect(result.unknownNames).toHaveLength(0);
  });
});
