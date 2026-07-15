/**
 * Tests for the structured onboarding module.
 *
 * Coverage goals:
 *  - getOnboardingStep() — all five outcomes (0, 1, 2, 3, "complete")
 *  - extractName / extractPractical / extractPersonality — JSON parsing + null-fallback paths (LLM mocked)
 *  - handleDirectOnboardingStep — step-routing, DB writes, sends (DB + sends mocked)
 *  - Mute / knowledge commands bypass the intercept even for in_progress users
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the OpenAI client so LLM extraction tests never hit the network.
// ---------------------------------------------------------------------------
vi.mock("../lib/openaiClient", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  },
  CHAT_MODEL: "gpt-4o",
}));

// ---------------------------------------------------------------------------
// Mock everything handleDirectOnboardingStep reaches outside onboarding.ts.
// ---------------------------------------------------------------------------
vi.mock("../lib/agent/delivery", () => ({ sendToThread: vi.fn() }));
vi.mock("../lib/agent/engine", () => ({ applyProfileUpdates: vi.fn() }));
vi.mock("@workspace/db", () => {
  const mockUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) }));
  const mockSelect = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) }));
  return { db: { update: mockUpdate, select: mockSelect }, usersTable: {}, profilesTable: {} };
});

// Prevent group kickoff recap from making DB calls in integration-style tests.
vi.mock("../lib/agent/context", () => ({
  getGroupThreadsForUser: vi.fn().mockResolvedValue([]),
  hasOnboardingRecapBeenSent: vi.fn().mockResolvedValue(true),
  isGroupFullyOnboarded: vi.fn().mockResolvedValue(false),
  loadThreadContext: vi.fn().mockResolvedValue({ participants: [] }),
  markOnboardingRecapSent: vi.fn().mockResolvedValue(undefined),
}));

import { openai } from "../lib/openaiClient";
import { sendToThread } from "../lib/agent/delivery";
import { applyProfileUpdates } from "../lib/agent/engine";
import { db } from "@workspace/db";

import {
  getOnboardingStep,
  buildPracticalConfirmation,
  buildPersonalityConfirmation,
  extractName,
  extractPractical,
  extractPersonality,
  ONBOARDING,
} from "../lib/agent/onboarding";
import { handleDirectOnboardingStep, checkAndSendGroupKickoffRecap } from "../lib/agent/onboardingFlow";

// Context mock handles — imported so individual tests can override with
// mockResolvedValueOnce to exercise specific recap paths.
import {
  getGroupThreadsForUser,
  hasOnboardingRecapBeenSent,
  isGroupFullyOnboarded,
  loadThreadContext,
  markOnboardingRecapSent,
} from "../lib/agent/context";

// Import after mocks are established.
import { detectMuteCommand } from "../lib/agent/etiquette";
import { detectKnowledgeCommand } from "../lib/agent/knowledge";

// handleDirectOnboardingStep is now exported from onboardingFlow.ts (extracted
// from sendblue.ts for testability). It accepts sendContactCard as an injected
// dependency so tests can stub it without touching the Sendblue API client.

// ============================================================================
// getOnboardingStep
// ============================================================================

describe("getOnboardingStep", () => {
  it("returns 0 when status is not_started (first-ever message)", () => {
    expect(getOnboardingStep("not_started", null, null)).toBe(0);
    expect(getOnboardingStep("not_started", "Alice", { budget: "$50", dietaryNeeds: null, preferences: ["Italian"] })).toBe(0);
  });

  it("returns 'complete' when status is completed", () => {
    expect(getOnboardingStep("completed", null, null)).toBe("complete");
    expect(getOnboardingStep("completed", "Alice", { budget: "$50", dietaryNeeds: null, preferences: ["Italian"] })).toBe("complete");
  });

  it("returns 1 when in_progress and displayName is missing", () => {
    expect(getOnboardingStep("in_progress", null, null)).toBe(1);
    expect(getOnboardingStep("in_progress", undefined, null)).toBe(1);
    expect(getOnboardingStep("in_progress", null, { budget: "$50", dietaryNeeds: "vegan", preferences: ["Thai"] })).toBe(1);
  });

  it("returns 2 when in_progress, has displayName, but no practical fields", () => {
    expect(getOnboardingStep("in_progress", "Alice", null)).toBe(2);
    expect(getOnboardingStep("in_progress", "Alice", { budget: null, dietaryNeeds: null, preferences: null })).toBe(2);
    expect(getOnboardingStep("in_progress", "Alice", { budget: null, dietaryNeeds: null, preferences: [] })).toBe(2);
  });

  it("returns 3 when in_progress, has name + practical, but no personality", () => {
    expect(getOnboardingStep("in_progress", "Alice", { budget: "$50", dietaryNeeds: null, preferences: null })).toBe(3);
    expect(getOnboardingStep("in_progress", "Alice", { budget: null, dietaryNeeds: "vegan", preferences: [] })).toBe(3);
    expect(getOnboardingStep("in_progress", "Alice", { budget: "$30", dietaryNeeds: "nut allergy", preferences: [] })).toBe(3);
  });

  it("returns 'complete' when all fields are present but status wasn't flipped", () => {
    // LLM may have populated fields before structured onboarding ran.
    expect(
      getOnboardingStep("in_progress", "Alice", { budget: "$50", dietaryNeeds: "vegan", preferences: ["Italian"] }),
    ).toBe("complete");
  });

  it("treats budget-only as sufficient for step 2 → step 3 transition", () => {
    // dietaryNeeds is null but budget is set — practical is satisfied.
    expect(getOnboardingStep("in_progress", "Alice", { budget: "$50", dietaryNeeds: null, preferences: null })).toBe(3);
  });

  it("treats dietaryNeeds-only as sufficient for step 2 → step 3 transition", () => {
    expect(getOnboardingStep("in_progress", "Alice", { budget: null, dietaryNeeds: "gluten-free", preferences: null })).toBe(3);
  });
});

// ============================================================================
// buildPracticalConfirmation / buildPersonalityConfirmation (pure)
// ============================================================================

describe("buildPracticalConfirmation", () => {
  it("includes both budget and dietaryNeeds when present", () => {
    expect(buildPracticalConfirmation("$50/head", "vegan")).toBe("Got it -- $50/head, vegan");
  });

  it("includes only budget when dietaryNeeds is null", () => {
    expect(buildPracticalConfirmation("$30", null)).toBe("Got it -- $30");
  });

  it("includes only dietaryNeeds when budget is null", () => {
    expect(buildPracticalConfirmation(null, "no shellfish")).toBe("Got it -- no shellfish");
  });

  it("returns plain 'Got it' when both are null", () => {
    expect(buildPracticalConfirmation(null, null)).toBe("Got it");
  });
});

describe("buildPersonalityConfirmation", () => {
  it("names up to two preferences", () => {
    expect(buildPersonalityConfirmation(["Italian", "low-key spots", "wine bars"])).toBe("Love it -- Italian & low-key spots");
  });

  it("names a single preference", () => {
    expect(buildPersonalityConfirmation(["sushi"])).toBe("Love it -- sushi");
  });

  it("falls back gracefully for empty array", () => {
    expect(buildPersonalityConfirmation([])).toBe("Got it");
  });
});

// ============================================================================
// extractName — mocked LLM
// ============================================================================

describe("extractName", () => {
  const mockCreate = openai.chat.completions.create as ReturnType<typeof vi.fn>;

  beforeEach(() => mockCreate.mockReset());

  function makeResponse(content: string) {
    return { choices: [{ message: { content } }] };
  }

  it("returns the extracted name from a clean reply", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse("Alice"));
    expect(await extractName("I'm Alice")).toBe("Alice");
  });

  it("trims whitespace from the response", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse("  Bob  "));
    expect(await extractName("call me Bob")).toBe("Bob");
  });

  it("returns null when the model replies with the literal word 'null'", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse("null"));
    expect(await extractName("I don't want to say")).toBeNull();
  });

  it("returns null when the model replies with an empty string", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse(""));
    expect(await extractName("???")).toBeNull();
  });

  it("returns null when the response is suspiciously long (> 3 words)", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse("My name is Alice Smith Jr."));
    expect(await extractName("some reply")).toBeNull();
  });

  it("returns null and does not throw when the LLM call fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network error"));
    expect(await extractName("hello")).toBeNull();
  });
});

// ============================================================================
// extractPractical — mocked LLM
// ============================================================================

describe("extractPractical", () => {
  const mockCreate = openai.chat.completions.create as ReturnType<typeof vi.fn>;

  beforeEach(() => mockCreate.mockReset());

  function makeResponse(content: string) {
    return { choices: [{ message: { content } }] };
  }

  it("parses a well-formed JSON object from the model", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"budget":"$50/head","dietaryNeeds":"vegan"}'));
    expect(await extractPractical("around $50, I'm vegan")).toEqual({ budget: "$50/head", dietaryNeeds: "vegan" });
  });

  it("strips markdown code fences before parsing", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse("```json\n{\"budget\":\"$30\",\"dietaryNeeds\":null}\n```"));
    expect(await extractPractical("$30 budget")).toEqual({ budget: "$30", dietaryNeeds: null });
  });

  it("returns null for both fields when the model says no info", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"budget":null,"dietaryNeeds":null}'));
    expect(await extractPractical("no preferences")).toEqual({ budget: null, dietaryNeeds: null });
  });

  it("coerces empty-string values to null", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('{"budget":"","dietaryNeeds":"gluten-free"}'));
    expect(await extractPractical("gluten-free only")).toEqual({ budget: null, dietaryNeeds: "gluten-free" });
  });

  it("returns {null, null} and does not throw when the LLM call fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("timeout"));
    expect(await extractPractical("anything")).toEqual({ budget: null, dietaryNeeds: null });
  });

  it("returns {null, null} on malformed JSON (not valid JSON at all)", async () => {
    mockCreate.mockResolvedValueOnce(makeResponse("I don't understand"));
    expect(await extractPractical("some text")).toEqual({ budget: null, dietaryNeeds: null });
  });
});

// ============================================================================
// extractPersonality — mocked LLM
// ============================================================================

describe("extractPersonality", () => {
  const mockCreate = openai.chat.completions.create as ReturnType<typeof vi.fn>;

  beforeEach(() => mockCreate.mockReset());

  function makeResponse(content: string) {
    return { choices: [{ message: { content } }] };
  }

  it("returns an array of up to 3 string tags", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '["Italian","wine bars","low-key"]' } }] });
    expect(await extractPersonality("love Italian wine bars, low-key spots")).toEqual(["Italian", "wine bars", "low-key"]);
  });

  it("strips markdown code fences before parsing", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "```json\n[\"sushi\"]\n```" } }] });
    expect(await extractPersonality("sushi all the way")).toEqual(["sushi"]);
  });

  it("returns an empty array when model responds with empty array", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "[]" } }] });
    expect(await extractPersonality("I don't know")).toEqual([]);
  });

  it("filters out non-string elements from the array", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '["Italian", 42, null, "casual"]' } }] });
    expect(await extractPersonality("mixed reply")).toEqual(["Italian", "casual"]);
  });

  it("returns at most 3 tags even if the model gives more", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '["a","b","c","d","e"]' } }],
    });
    const result = await extractPersonality("verbose reply");
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("returns [] and does not throw when the LLM call fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("quota exceeded"));
    expect(await extractPersonality("anything")).toEqual([]);
  });

  it("returns [] when the model returns a non-array (malformed JSON)", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"tag":"Italian"}' } }] });
    expect(await extractPersonality("Italian food")).toEqual([]);
  });
});

// ============================================================================
// Mute / knowledge commands bypass the onboarding intercept
//
// The webhook handler checks detectMuteCommand and detectKnowledgeCommand
// *before* the onboarding intercept block. These tests confirm that those
// functions fire on the exact message strings that should bypass onboarding,
// regardless of the user's onboarding step.
// ============================================================================

describe("Mute / knowledge bypass preconditions", () => {
  it("detectMuteCommand fires for an in_progress user's 'mute' message", () => {
    // An in_progress user sending "mute yourself" would be at step 1 or 2.
    // The webhook must catch the mute command before routing to onboarding.
    const step = getOnboardingStep("in_progress", null, null); // step 1
    expect(step).toBe(1); // confirm the user is mid-onboarding

    const cmd = detectMuteCommand("mute yourself");
    expect(cmd).toBe("mute"); // non-null → handler returns early before onboarding
  });

  it("detectMuteCommand fires for an in_progress user's 'be quiet' message", () => {
    const step = getOnboardingStep("in_progress", "Alice", { budget: null, dietaryNeeds: null, preferences: null }); // step 2
    expect(step).toBe(2);

    const cmd = detectMuteCommand("be quiet");
    expect(cmd).toBe("mute");
  });

  it("detectKnowledgeCommand fires for 'what do you know about me' during onboarding", () => {
    const step = getOnboardingStep("in_progress", null, null); // step 1
    expect(step).toBe(1);

    const cmd = detectKnowledgeCommand("what do you know about me");
    expect(cmd).not.toBeNull(); // non-null → knowledge handler runs, onboarding skipped
  });

  it("a normal onboarding reply does NOT trigger either bypass", () => {
    // "My name is Alice" should not be detected as a mute or knowledge command.
    expect(detectMuteCommand("My name is Alice")).toBeNull();
    expect(detectKnowledgeCommand("My name is Alice")).toBeNull();
  });
});

// ============================================================================
// handleDirectOnboardingStep — step-routing integration tests
//
// The function is extracted to onboardingFlow.ts so it can be imported and
// tested here without pulling in the full sendblue.ts dependency graph.
// sendContactCard is injected as a stub; DB and send mocks are reused from
// the top-level vi.mock() calls above.
// ============================================================================

describe("handleDirectOnboardingStep — step 0 (first-ever message)", () => {
  const mockSendContactCard = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendContactCard.mockResolvedValue(undefined);
  });

  it("calls sendContactCard with the user's userId and phone", async () => {
    await handleDirectOnboardingStep(0, 1, 10, "hello", null, null, "+15551234567", mockSendContactCard);
    expect(mockSendContactCard).toHaveBeenCalledWith(1, "+15551234567");
  });

  it("sends the intro message to the thread", async () => {
    await handleDirectOnboardingStep(0, 1, 10, "hello", null, null, "+15551234567", mockSendContactCard);
    expect(sendToThread).toHaveBeenCalledWith(10, ONBOARDING.directDm.intro);
  });

  it("marks the user in_progress via a DB update", async () => {
    await handleDirectOnboardingStep(0, 1, 10, "hello", null, null, "+15551234567", mockSendContactCard);
    expect(db.update).toHaveBeenCalled();
  });

  it("does not call applyProfileUpdates", async () => {
    await handleDirectOnboardingStep(0, 1, 10, "hello", null, null, "+15551234567", mockSendContactCard);
    expect(applyProfileUpdates).not.toHaveBeenCalled();
  });
});

describe("handleDirectOnboardingStep — step 1 (waiting for name)", () => {
  const mockCreate = openai.chat.completions.create as ReturnType<typeof vi.fn>;
  const mockSendContactCard = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendContactCard.mockResolvedValue(undefined);
  });

  it("writes displayName and sends askPractical when name is extracted", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "Alice" } }] });
    await handleDirectOnboardingStep(1, 1, 10, "I'm Alice", null, null, "+15551234567", mockSendContactCard);
    expect(db.update).toHaveBeenCalled();
    expect(sendToThread).toHaveBeenCalledWith(10, ONBOARDING.directDm.askPractical("Alice"));
  });

  it("sends the fallback message and skips the DB write when extraction returns null", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "null" } }] });
    await handleDirectOnboardingStep(1, 1, 10, "???", null, null, "+15551234567", mockSendContactCard);
    expect(sendToThread).toHaveBeenCalledWith(10, "Sorry, what should I call you?");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("sends the fallback message when the LLM call throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network error"));
    await handleDirectOnboardingStep(1, 1, 10, "something", null, null, "+15551234567", mockSendContactCard);
    expect(sendToThread).toHaveBeenCalledWith(10, "Sorry, what should I call you?");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not call sendContactCard", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "Bob" } }] });
    await handleDirectOnboardingStep(1, 1, 10, "call me Bob", null, null, "+15551234567", mockSendContactCard);
    expect(mockSendContactCard).not.toHaveBeenCalled();
  });
});

describe("handleDirectOnboardingStep — step 2 (waiting for practical)", () => {
  const mockCreate = openai.chat.completions.create as ReturnType<typeof vi.fn>;
  const mockSendContactCard = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendContactCard.mockResolvedValue(undefined);
  });

  it("calls applyProfileUpdates with budget and sends askPersonality", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"budget":"$50","dietaryNeeds":null}' } }] });
    await handleDirectOnboardingStep(2, 1, 10, "around $50", "Alice", null, "+15551234567", mockSendContactCard);
    expect(applyProfileUpdates).toHaveBeenCalledWith(1, { budget: "$50" });
    expect(sendToThread).toHaveBeenCalledWith(10, expect.stringContaining("go-to cuisine"));
  });

  it("calls applyProfileUpdates with dietaryNeeds when budget is null", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"budget":null,"dietaryNeeds":"vegan"}' } }] });
    await handleDirectOnboardingStep(2, 1, 10, "I'm vegan", "Alice", null, "+15551234567", mockSendContactCard);
    expect(applyProfileUpdates).toHaveBeenCalledWith(1, { dietaryNeeds: "vegan" });
    expect(sendToThread).toHaveBeenCalledWith(10, expect.stringContaining("go-to cuisine"));
  });

  it("skips applyProfileUpdates but still sends askPersonality when neither field is extracted", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"budget":null,"dietaryNeeds":null}' } }] });
    await handleDirectOnboardingStep(2, 1, 10, "no preferences", "Alice", null, "+15551234567", mockSendContactCard);
    expect(applyProfileUpdates).not.toHaveBeenCalled();
    expect(sendToThread).toHaveBeenCalledWith(10, expect.stringContaining("go-to cuisine"));
  });

  it("prefixes askPersonality with a budget confirmation when budget is present", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"budget":"$30/head","dietaryNeeds":null}' } }] });
    await handleDirectOnboardingStep(2, 1, 10, "$30", "Alice", null, "+15551234567", mockSendContactCard);
    const sentMsg = (sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(sentMsg).toContain("$30/head");
  });
});

describe("handleDirectOnboardingStep — step 3 (personality signal, completion)", () => {
  const mockCreate = openai.chat.completions.create as ReturnType<typeof vi.fn>;
  const mockSendContactCard = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendContactCard.mockResolvedValue(undefined);
  });

  it("saves preferences, sends the completion message, and marks completed in DB", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '["Italian","wine bars"]' } }] });
    await handleDirectOnboardingStep(
      3, 1, 10, "love Italian wine bars", "Alice",
      { budget: "$50", dietaryNeeds: null, preferences: [] }, "+15551234567", mockSendContactCard,
    );
    expect(applyProfileUpdates).toHaveBeenCalledWith(1, { preferences: ["Italian", "wine bars"] });
    expect(sendToThread).toHaveBeenCalledWith(10, expect.stringContaining("All set"));
    expect(db.update).toHaveBeenCalled();
  });

  it("still sends the completion message even when personality extraction returns an empty array", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "[]" } }] });
    await handleDirectOnboardingStep(
      3, 1, 10, "I don't know", "Alice",
      { budget: "$50", dietaryNeeds: null, preferences: [] }, "+15551234567", mockSendContactCard,
    );
    expect(applyProfileUpdates).not.toHaveBeenCalled();
    expect(sendToThread).toHaveBeenCalledWith(10, expect.stringContaining("All set"));
    expect(db.update).toHaveBeenCalled();
  });

  it("prefixes the completion message with personality confirmation when preferences are present", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '["sushi"]' } }] });
    await handleDirectOnboardingStep(
      3, 1, 10, "I love sushi", "Alice",
      { budget: null, dietaryNeeds: null, preferences: [] }, "+15551234567", mockSendContactCard,
    );
    const sentMsg = (sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(sentMsg).toContain("sushi");
  });

  it("does not call sendContactCard", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "[]" } }] });
    await handleDirectOnboardingStep(
      3, 1, 10, "whatever", "Alice",
      { budget: null, dietaryNeeds: null, preferences: [] }, "+15551234567", mockSendContactCard,
    );
    expect(mockSendContactCard).not.toHaveBeenCalled();
  });
});

// ============================================================================
// checkAndSendGroupKickoffRecap — direct unit tests
//
// The top-level vi.mock("../lib/agent/context") sets safe defaults:
//   getGroupThreadsForUser → []           (no groups — function is a no-op)
//   hasOnboardingRecapBeenSent → true     (recap already sent — skip)
//   isGroupFullyOnboarded → false         (group not ready — skip)
//   loadThreadContext → { participants: [] }
//
// Each test overrides the specific mocks it needs via mockResolvedValueOnce.
// ============================================================================

describe("checkAndSendGroupKickoffRecap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the recap message to a fully-onboarded group that hasn't received it yet", async () => {
    (getGroupThreadsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 99 }]);
    (hasOnboardingRecapBeenSent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (isGroupFullyOnboarded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (loadThreadContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      participants: [
        { user: { displayName: "Alice" }, profile: null },
        { user: { displayName: "Bob" }, profile: null },
      ],
    });

    await checkAndSendGroupKickoffRecap(1);

    expect(sendToThread).toHaveBeenCalledWith(99, expect.stringContaining("Everyone's set up now"));
    expect(sendToThread).toHaveBeenCalledWith(99, expect.stringContaining("Alice"));
    expect(sendToThread).toHaveBeenCalledWith(99, expect.stringContaining("Bob"));
    expect(markOnboardingRecapSent).toHaveBeenCalledWith(99);
  });

  it("does not send when the group is not yet fully onboarded", async () => {
    (getGroupThreadsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 99 }]);
    (hasOnboardingRecapBeenSent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    // isGroupFullyOnboarded stays false (default)

    await checkAndSendGroupKickoffRecap(1);

    expect(sendToThread).not.toHaveBeenCalled();
    expect(markOnboardingRecapSent).not.toHaveBeenCalled();
  });

  it("does not send when the recap was already sent for this group", async () => {
    (getGroupThreadsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 99 }]);
    // hasOnboardingRecapBeenSent stays true (default) — recap guard skips this group

    await checkAndSendGroupKickoffRecap(1);

    expect(sendToThread).not.toHaveBeenCalled();
    expect(markOnboardingRecapSent).not.toHaveBeenCalled();
  });

  it("includes public preferences in the recap line", async () => {
    (getGroupThreadsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 99 }]);
    (hasOnboardingRecapBeenSent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (isGroupFullyOnboarded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (loadThreadContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      participants: [
        {
          user: { displayName: "Alice" },
          profile: { preferencesVisibility: "public", preferences: ["Italian", "wine bars"] },
        },
      ],
    });

    await checkAndSendGroupKickoffRecap(1);

    const sentMsg = (sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(sentMsg).toContain("Italian");
    expect(sentMsg).toContain("wine bars");
  });

  it("omits private preferences from the recap line", async () => {
    (getGroupThreadsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 99 }]);
    (hasOnboardingRecapBeenSent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (isGroupFullyOnboarded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (loadThreadContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      participants: [
        {
          user: { displayName: "Alice" },
          profile: { preferencesVisibility: "private", preferences: ["sushi"] },
        },
      ],
    });

    await checkAndSendGroupKickoffRecap(1);

    const sentMsg = (sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(sentMsg).toContain("Alice");
    expect(sentMsg).not.toContain("sushi");
  });

  it("skips a group whose recap was already sent and still processes a second ready group", async () => {
    (getGroupThreadsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 99 }, { id: 100 }]);
    (hasOnboardingRecapBeenSent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(true)    // group 99: already sent → skipped
      .mockResolvedValueOnce(false);  // group 100: not sent → eligible
    (isGroupFullyOnboarded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true); // group 100
    (loadThreadContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ participants: [] });

    await checkAndSendGroupKickoffRecap(1);

    expect(sendToThread).toHaveBeenCalledWith(100, expect.stringContaining("Everyone's set up now"));
    expect(markOnboardingRecapSent).toHaveBeenCalledWith(100);
    expect(markOnboardingRecapSent).not.toHaveBeenCalledWith(99);
  });

  it("fires when called from step 3 of handleDirectOnboardingStep if the group is ready", async () => {
    const mockCreate = openai.chat.completions.create as ReturnType<typeof vi.fn>;
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '["sushi"]' } }] });

    (getGroupThreadsForUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 99 }]);
    (hasOnboardingRecapBeenSent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (isGroupFullyOnboarded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    (loadThreadContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      participants: [{ user: { displayName: "Alice" }, profile: null }],
    });

    await handleDirectOnboardingStep(
      3, 1, 10, "I love sushi", "Alice",
      { budget: null, dietaryNeeds: null, preferences: [] }, "+15551234567", vi.fn().mockResolvedValue(undefined),
    );

    // sendToThread fires twice: completion message (threadId=10) and group recap (threadId=99).
    expect(sendToThread).toHaveBeenCalledWith(10, expect.stringContaining("All set"));
    expect(sendToThread).toHaveBeenCalledWith(99, expect.stringContaining("Everyone's set up now"));
    expect(markOnboardingRecapSent).toHaveBeenCalledWith(99);
  });
});
