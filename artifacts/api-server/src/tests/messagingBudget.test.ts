import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB before importing the module under test so the DB calls are fully
// isolated -- these tests cover the budget logic, not the persistence layer.
vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), insert: vi.fn() },
  proactiveMessageSendsTable: {},
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args) => args),
  eq: vi.fn((...args) => args),
  gte: vi.fn((...args) => args),
}));

import { canSendProactiveMessage, PROACTIVE_CATEGORY_PRIORITY } from "../lib/agent/messagingBudget";
import { db } from "@workspace/db";

// Helper to make db.select().from().where() return a specific row count.
function mockDbRows(rows: object[]) {
  const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
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
    // 0 rows in each query → both counts are 0 → under all caps
    mockDbRows([]);
    const result = await canSendProactiveMessage(1, "nudge");
    expect(result).toBe(true);
  });

  it("returns false when the category cap is reached", async () => {
    // nudge cap is 2 per day; return 2 rows for the category count query.
    let callCount = 0;
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        // First call = category count (2 = at cap), second = daily total (0)
        return Promise.resolve(callCount === 1 ? [{}, {}] : []);
      }),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const result = await canSendProactiveMessage(1, "nudge");
    expect(result).toBe(false);
  });

  it("returns false when the daily thread ceiling is reached", async () => {
    let callCount = 0;
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        // First call = category count (0), second = daily total (3 = at ceiling)
        return Promise.resolve(callCount === 1 ? [] : [{}, {}, {}]);
      }),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const result = await canSendProactiveMessage(1, "serendipity");
    expect(result).toBe(false);
  });

  it("returns true when only the category count is 0 and daily is under ceiling", async () => {
    let callCount = 0;
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        callCount++;
        // 0 category sends, 1 other send today (under ceiling of 3)
        return Promise.resolve(callCount === 1 ? [] : [{}]);
      }),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const result = await canSendProactiveMessage(1, "plan_reminder");
    expect(result).toBe(true);
  });
});
