import { describe, it, expect, vi } from "vitest";
import { scrubPrivateProfileLeaks } from "../lib/agent/privacy";
import type { ThreadParticipantContext } from "../lib/agent/context";

// Suppress logger noise during tests.
vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeParticipant(overrides: {
  budget?: string | null;
  budgetVisibility?: string;
  dietaryNeeds?: string | null;
  dietaryNeedsVisibility?: string;
  notes?: string | null;
  notesVisibility?: string;
  preferences?: string[];
  preferencesVisibility?: string;
} = {}): ThreadParticipantContext {
  return {
    user: { id: 1, phoneNumber: "+15550001234", displayName: "Alex", onboardingStatus: "completed", createdAt: new Date(), updatedAt: new Date() },
    profile: {
      userId: 1,
      budget: overrides.budget ?? null,
      budgetVisibility: (overrides.budgetVisibility ?? "private") as "private" | "shared",
      dietaryNeeds: overrides.dietaryNeeds ?? null,
      dietaryNeedsVisibility: (overrides.dietaryNeedsVisibility ?? "private") as "private" | "shared",
      notes: overrides.notes ?? null,
      notesVisibility: (overrides.notesVisibility ?? "private") as "private" | "shared",
      preferences: overrides.preferences ?? [],
      preferencesVisibility: (overrides.preferencesVisibility ?? "private") as "private" | "shared",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as ThreadParticipantContext;
}

describe("scrubPrivateProfileLeaks", () => {
  it("redacts a private budget value that appears verbatim in a reply", () => {
    const p = makeParticipant({ budget: "$50 per person", budgetVisibility: "private" });
    const result = scrubPrivateProfileLeaks("We kept it under $50 per person for everyone.", [p]);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("$50 per person");
  });

  it("redacts a private dietary restriction that leaks into a reply", () => {
    const p = makeParticipant({ dietaryNeeds: "vegan", dietaryNeedsVisibility: "private" });
    const result = scrubPrivateProfileLeaks("This place has great vegan options for the group.", [p]);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("vegan");
  });

  it("does NOT redact shared profile values", () => {
    const p = makeParticipant({ budget: "$100 max", budgetVisibility: "shared" });
    const result = scrubPrivateProfileLeaks("Budget is $100 max per person.", [p]);
    expect(result).toBe("Budget is $100 max per person.");
  });

  it("does NOT redact when the private value does not appear in the reply", () => {
    const p = makeParticipant({ budget: "very tight", budgetVisibility: "private" });
    const result = scrubPrivateProfileLeaks("Great spot, affordable for the group.", [p]);
    expect(result).toBe("Great spot, affordable for the group.");
  });

  it("redacts case-insensitively", () => {
    const p = makeParticipant({ notes: "No cilantro", notesVisibility: "private" });
    const result = scrubPrivateProfileLeaks("We avoided NO CILANTRO dishes for everyone.", [p]);
    expect(result).toContain("[redacted]");
  });

  it("does not redact values shorter than the minimum redactable length", () => {
    // "ok" is 2 chars, below MIN_REDACTABLE_LENGTH=3, should not be redacted
    const p = makeParticipant({ notes: "ok", notesVisibility: "private" });
    const result = scrubPrivateProfileLeaks("This is ok for everyone.", [p]);
    expect(result).toBe("This is ok for everyone.");
  });

  it("handles participants with no profile gracefully", () => {
    const p = { user: { id: 2, phoneNumber: "+15550000000", displayName: null, onboardingStatus: "pending", createdAt: new Date(), updatedAt: new Date() }, profile: null } as unknown as ThreadParticipantContext;
    const result = scrubPrivateProfileLeaks("Some reply text here.", [p]);
    expect(result).toBe("Some reply text here.");
  });
});
