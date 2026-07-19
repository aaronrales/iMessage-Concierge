import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB before importing the module under test so the DB calls are fully
// isolated -- these tests cover the budget logic, not the persistence layer.
vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), insert: vi.fn() },
  proactiveMessageSendsTable: {},
  threadParticipantsTable: {},
  usersTable: {},
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args) => args),
  eq: vi.fn((...args) => args),
  gte: vi.fn((...args) => args),
}));

import { canSendProactiveMessage, PROACTIVE_CATEGORY_PRIORITY } from "../lib/agent/messagingBudget";
import { db } from "@workspace/db";

/**
 * Builds a fully chainable drizzle-style select mock.
 * `.limit()` is the terminal call for `threadHasOptedOutParticipant`;
 * `.where()` is terminal for `countSendsSince`.
 * Both return a promise so callers can await either chain.
 *
 * All method stubs are defined on the object first, then wired up, so that
 * each `.mockReturnValue(chain)` captures the fully-populated reference.
 */
function makeChain(rows: object[]) {
  const promise = Promise.resolve(rows);
  const whereResult = { then: promise.then.bind(promise), catch: promise.catch.bind(promise), finally: promise.finally.bind(promise), limit: vi.fn().mockReturnValue(promise) };
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn().mockReturnValue(whereResult),
    limit: vi.fn().mockReturnValue(promise),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  return chain;
}

/**
 * Sets up db.select to return:
 *   - call 1 (threadHasOptedOutParticipant): [] (no opted-out users, so check passes)
 *   - calls 2+ (countSendsSince via Promise.all): the provided `budgetRows`
 */
function mockBudgetRows(budgetRows: object[]) {
  let callCount = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    callCount++;
    // First call is the doNotContact check — return empty (no opted-out participants).
    return makeChain(callCount === 1 ? [] : budgetRows);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PROACTIVE_CATEGORY_PRIORITY", () => {
  it("lists occasion_reminder first (highest priority)", () => {
    expect(PROACTIVE_CATEGORY_PRIORITY[0]).toBe("occasion_reminder");
  });

  it("lists serendipity last (lowest priority)", () => {
    expect(PROACTIVE_CATEGORY_PRIORITY[PROACTIVE_CATEGORY_PRIORITY.length - 1]).toBe("serendipity");
  });
});

describe("canSendProactiveMessage", () => {
  it("returns true when category and daily counts are both under their caps", async () => {
    // 0 budget rows → both counts are 0 → under all caps
    mockBudgetRows([]);
    const result = await canSendProactiveMessage(1, "nudge");
    expect(result).toBe(true);
  });

  it("returns false when the category cap is reached", async () => {
    // nudge cap is 2 per day; first budget call returns 2 rows (category at cap).
    let budgetCallCount = 0;
    let totalCallCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      totalCallCount++;
      if (totalCallCount === 1) {
        // threadHasOptedOutParticipant → no opted-out users
        return makeChain([]);
      }
      budgetCallCount++;
      // First budget call = category count (2 = at cap), second = daily total (0)
      return makeChain(budgetCallCount === 1 ? [{}, {}] : []);
    });

    const result = await canSendProactiveMessage(1, "nudge");
    expect(result).toBe(false);
  });

  it("returns false when the daily thread ceiling is reached", async () => {
    let budgetCallCount = 0;
    let totalCallCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      totalCallCount++;
      if (totalCallCount === 1) {
        return makeChain([]);
      }
      budgetCallCount++;
      // First budget call = category count (0), second = daily total (3 = at ceiling)
      return makeChain(budgetCallCount === 1 ? [] : [{}, {}, {}]);
    });

    const result = await canSendProactiveMessage(1, "serendipity");
    expect(result).toBe(false);
  });

  it("returns true when only the category count is 0 and daily is under ceiling", async () => {
    let budgetCallCount = 0;
    let totalCallCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      totalCallCount++;
      if (totalCallCount === 1) {
        return makeChain([]);
      }
      budgetCallCount++;
      // 0 category sends, 1 other send today (under ceiling of 3)
      return makeChain(budgetCallCount === 1 ? [] : [{}]);
    });

    const result = await canSendProactiveMessage(1, "plan_reminder");
    expect(result).toBe(true);
  });

  it("returns false when an opted-out participant is in the thread", async () => {
    // threadHasOptedOutParticipant returns one row → opted out → block send
    let totalCallCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      totalCallCount++;
      return makeChain(totalCallCount === 1 ? [{ doNotContact: true }] : []);
    });

    const result = await canSendProactiveMessage(1, "nudge");
    expect(result).toBe(false);
  });
});
