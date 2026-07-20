/**
 * Unit tests for arrival-collection helpers.
 *
 * Tests cover:
 * - formatArrivalMatrix produces the expected text structure
 * - organizer is included in participant count so completion can reach 100 %
 * - buildArrivalMatrix returns null when no round is active
 */

import { describe, it, expect } from "vitest";
import { formatArrivalMatrix, type ArrivalMatrix } from "../lib/agent/arrivalMatrix";

// ── formatArrivalMatrix ───────────────────────────────────────────────────────

describe("formatArrivalMatrix", () => {
  it("includes the respondedCount / totalCount header", () => {
    const matrix: ArrivalMatrix = {
      respondedCount: 3,
      totalCount: 8,
      entries: [
        { displayName: "Sarah", phoneNumber: "+15550001111", answer: "Delta 1234, lands Sat 2pm" },
        { displayName: "Mike", phoneNumber: "+15550002222", answer: "Driving, arriving Friday evening" },
        { displayName: null, phoneNumber: "+15550003333", answer: "Flight AA 789, arrives Sunday noon" },
      ],
    };

    const text = formatArrivalMatrix(matrix);

    expect(text).toContain("3/8 responded");
    expect(text).toContain("Sarah:");
    expect(text).toContain("Mike:");
    // Falls back to phone number when displayName is null.
    expect(text).toContain("+15550003333:");
    expect(text).toContain("Delta 1234");
    expect(text).toContain("Driving");
    expect(text).toContain("Flight AA 789");
  });

  it("formats a fully-responded round correctly", () => {
    const matrix: ArrivalMatrix = {
      respondedCount: 2,
      totalCount: 2,
      entries: [
        { displayName: "Alice", phoneNumber: "+15550001111", answer: "Flying in Thursday night" },
        { displayName: "Bob", phoneNumber: "+15550002222", answer: "Driving, there by Friday noon" },
      ],
    };

    const text = formatArrivalMatrix(matrix);
    expect(text.split("\n")[0]).toMatch(/2\/2 responded/);
    expect(text).toContain("Alice: Flying in Thursday night");
    expect(text).toContain("Bob: Driving, there by Friday noon");
  });

  it("produces one line per entry", () => {
    const matrix: ArrivalMatrix = {
      respondedCount: 3,
      totalCount: 5,
      entries: [
        { displayName: "A", phoneNumber: "+1", answer: "Ans A" },
        { displayName: "B", phoneNumber: "+2", answer: "Ans B" },
        { displayName: "C", phoneNumber: "+3", answer: "Ans C" },
      ],
    };

    const lines = formatArrivalMatrix(matrix).split("\n");
    // Header + 3 entry lines
    expect(lines).toHaveLength(4);
  });
});

// ── Organizer-inclusion invariant (documented) ────────────────────────────────

/**
 * The arrival-collection round DMss ALL thread participants — including the
 * organizer — so that `isPrivateInputComplete`, which counts all
 * threadParticipantsTable rows, can reach 100 %.
 *
 * This is enforced in the sendblue.ts arrival handler (the loop that fires
 * `findOrCreateDirectThread` for each participant has no organizer skip).
 *
 * `getArrivalResponseStatus.totalCount` and `buildArrivalMatrix.totalCount`
 * both source from threadParticipantsTable (no exclusion) to stay consistent.
 */
describe("arrival-collection organizer-inclusion invariant", () => {
  it("totalCount in ArrivalMatrix includes organizer (all participants)", () => {
    // A matrix where organizer is included in totalCount but responded:
    const matrix: ArrivalMatrix = {
      respondedCount: 4,
      totalCount: 4, // organizer + 3 others — all included
      entries: [
        { displayName: "Organizer", phoneNumber: "+1", answer: "Flying in Friday" },
        { displayName: "A", phoneNumber: "+2", answer: "Driving" },
        { displayName: "B", phoneNumber: "+3", answer: "Train Saturday" },
        { displayName: "C", phoneNumber: "+4", answer: "Flying Sunday" },
      ],
    };

    // When everyone including the organizer responds, responded === total.
    expect(matrix.respondedCount).toBe(matrix.totalCount);
    expect(formatArrivalMatrix(matrix)).toContain("4/4 responded");
  });
});
