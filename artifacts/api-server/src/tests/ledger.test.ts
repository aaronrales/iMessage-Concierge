import { describe, it, expect } from "vitest";
import {
  buildVenmoLink,
  buildZelleInstruction,
  formatDollars,
  buildPaymentRequestMessage,
  PAYMENT_NUDGE_GRACE_DAYS,
  PAYMENT_NUDGE_REPEAT_DAYS,
} from "../lib/agent/ledger";

// ── formatDollars ─────────────────────────────────────────────────────────────

describe("formatDollars", () => {
  it("formats even dollar amounts without cents", () => {
    expect(formatDollars(30000)).toBe("$300");
    expect(formatDollars(100)).toBe("$1");
    expect(formatDollars(0)).toBe("$0");
  });

  it("formats fractional amounts with cents", () => {
    expect(formatDollars(30050)).toBe("$300.50");
    expect(formatDollars(1)).toBe("$0.01");
    expect(formatDollars(150)).toBe("$1.50");
  });

  it("handles large amounts correctly", () => {
    expect(formatDollars(240000)).toBe("$2400");
    expect(formatDollars(250099)).toBe("$2500.99");
  });
});

// ── buildVenmoLink ────────────────────────────────────────────────────────────

describe("buildVenmoLink", () => {
  it("generates a venmo.com URL", () => {
    const url = buildVenmoLink(30000, "Airbnb deposit");
    expect(url).toContain("venmo.com");
    expect(url).toContain("amount=300.00");
  });

  it("sets txn=pay", () => {
    const url = buildVenmoLink(10000, "test");
    expect(url).toContain("txn=pay");
  });

  it("URL-encodes the note", () => {
    const url = buildVenmoLink(5000, "Bachelorette trip expenses");
    expect(url).toContain("note=");
    // note should be present — decode both %xx and + (query-string convention).
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain("Bachelorette trip expenses");
  });

  it("truncates note to 280 chars", () => {
    const longNote = "a".repeat(400);
    const url = buildVenmoLink(1000, longNote);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("note")!.length).toBeLessThanOrEqual(280);
  });

  it("handles fractional dollar amounts correctly", () => {
    const url = buildVenmoLink(5050, "Coffee fund");
    expect(url).toContain("amount=50.50");
  });

  it("different amounts produce different URLs", () => {
    const url1 = buildVenmoLink(10000, "Trip");
    const url2 = buildVenmoLink(20000, "Trip");
    expect(url1).not.toBe(url2);
  });

  it("different notes produce different URLs", () => {
    const url1 = buildVenmoLink(10000, "Deposit");
    const url2 = buildVenmoLink(10000, "Food fund");
    expect(url1).not.toBe(url2);
  });
});

// ── buildZelleInstruction ─────────────────────────────────────────────────────

describe("buildZelleInstruction", () => {
  it("includes the recipient phone number", () => {
    const text = buildZelleInstruction("+12125551234", 30000);
    expect(text).toContain("+12125551234");
  });

  it("includes the formatted dollar amount", () => {
    const text = buildZelleInstruction("+12125551234", 30000);
    expect(text).toContain("$300");
  });

  it("mentions Zelle", () => {
    const text = buildZelleInstruction("+12125551234", 5000);
    expect(text.toLowerCase()).toContain("zelle");
  });
});

// ── buildPaymentRequestMessage ────────────────────────────────────────────────

describe("buildPaymentRequestMessage", () => {
  it("includes recipient name and amount", () => {
    const msg = buildPaymentRequestMessage("Jake", 30000, "Airbnb deposit", "Mia");
    expect(msg).toContain("Jake");
    expect(msg).toContain("$300");
    expect(msg).toContain("Airbnb deposit");
  });

  it("includes the Venmo link", () => {
    const msg = buildPaymentRequestMessage("Sarah", 15000, "House fund", "Alex");
    expect(msg).toContain("venmo.com");
  });

  it("includes Zelle instruction when organizer phone is provided", () => {
    const msg = buildPaymentRequestMessage("Jake", 30000, "Deposit", "Mia", "+12125550001");
    expect(msg.toLowerCase()).toContain("zelle");
    expect(msg).toContain("+12125550001");
  });

  it("omits Zelle when organizer phone is null", () => {
    const msg = buildPaymentRequestMessage("Jake", 30000, "Deposit", "Mia", null);
    expect(msg.toLowerCase()).not.toContain("zelle");
  });

  it("names the organizer who should receive the money", () => {
    const msg = buildPaymentRequestMessage("Jake", 30000, "Deposit", "Mia");
    expect(msg).toContain("Mia");
  });

  it("does not use custody-implying language", () => {
    const msg = buildPaymentRequestMessage("Jake", 30000, "Deposit", "Mia");
    const lower = msg.toLowerCase();
    // The agent must never claim to hold, collect, or process money.
    expect(lower).not.toContain("i've collected");
    expect(lower).not.toContain("i will send");
    expect(lower).not.toContain("i'll send the money");
    expect(lower).not.toContain("i hold");
  });
});

// ── Per-person math ───────────────────────────────────────────────────────────

describe("per-person estimate math", () => {
  it("$2,400 split 8 ways = $300 each", () => {
    const total = 240000; // cents
    const headcount = 8;
    const perPerson = Math.round(total / headcount);
    expect(perPerson).toBe(30000);
    expect(formatDollars(perPerson)).toBe("$300");
  });

  it("$1,500 split 6 ways = $250 each", () => {
    const perPerson = Math.round(150000 / 6);
    expect(perPerson).toBe(25000);
    expect(formatDollars(perPerson)).toBe("$250");
  });

  it("rounds to nearest cent when total is not evenly divisible", () => {
    // $100 split 3 ways = ~$33.33 → 3333 cents
    const perPerson = Math.round(10000 / 3);
    expect(perPerson).toBe(3333);
  });

  it("$0 split returns 0", () => {
    expect(Math.round(0 / 5)).toBe(0);
  });
});

// ── Governor constants ────────────────────────────────────────────────────────

describe("payment nudge constants", () => {
  it("grace period is 3 days", () => {
    expect(PAYMENT_NUDGE_GRACE_DAYS).toBe(3);
  });

  it("repeat nudge minimum is 5 days", () => {
    expect(PAYMENT_NUDGE_REPEAT_DAYS).toBe(5);
  });

  it("repeat cadence is strictly larger than grace period (no immediate re-nudge)", () => {
    expect(PAYMENT_NUDGE_REPEAT_DAYS).toBeGreaterThan(PAYMENT_NUDGE_GRACE_DAYS);
  });
});

// ── Outstanding balance logic (pure, no DB) ──────────────────────────────────

describe("outstanding balance computation rules", () => {
  it("outstanding = estimate - payment (positive)", () => {
    const estimatedCents = 30000;
    const paidCents = 10000;
    const outstanding = Math.max(0, estimatedCents - paidCents);
    expect(outstanding).toBe(20000);
  });

  it("outstanding is clamped to 0 when overpaid", () => {
    const estimatedCents = 30000;
    const paidCents = 35000; // overpaid (organizer may have miscounted)
    const outstanding = Math.max(0, estimatedCents - paidCents);
    expect(outstanding).toBe(0);
  });

  it("outstanding equals estimate when nothing paid", () => {
    const estimatedCents = 30000;
    const paidCents = 0;
    const outstanding = Math.max(0, estimatedCents - paidCents);
    expect(outstanding).toBe(estimatedCents);
  });

  it("getLedgerSummary returns null when no estimates exist (type contract)", async () => {
    // Import here so the DB call is made (resolves to null for non-existent project).
    const { getLedgerSummary } = await import("../lib/agent/ledger");
    const result = await getLedgerSummary(999999);
    expect(result).toBeNull();
  });
});

// ── Nudge eligibility logic (pure, no DB) ────────────────────────────────────

// ── findThreadMemberByName — null display-name guard ─────────────────────────

describe("findThreadMemberByName name matching rules", () => {
  /**
   * Simulates the matching logic extracted from findThreadMemberByName.
   * Keeps the tests pure (no DB) while covering the exact matching rules.
   */
  function matchMember(
    participants: Array<{ id: number; displayName: string | null; phoneNumber: string }>,
    query: string,
  ) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return null;

    const exact = participants.find((p) => p.displayName?.trim().toLowerCase() === normalized);
    if (exact) return exact;

    const partial = participants.find((p) => {
      const dn = p.displayName?.trim().toLowerCase();
      if (!dn) return false;
      return dn.includes(normalized) || normalized.includes(dn);
    });
    return partial ?? null;
  }

  it("exact match returns the correct participant", () => {
    const participants = [
      { id: 1, displayName: "Jake", phoneNumber: "+1" },
      { id: 2, displayName: "Sarah", phoneNumber: "+2" },
    ];
    expect(matchMember(participants, "Jake")?.id).toBe(1);
    expect(matchMember(participants, "jake")?.id).toBe(1); // case-insensitive
  });

  it("null display name is never matched on partial logic", () => {
    const participants = [
      { id: 1, displayName: null, phoneNumber: "+1" },
      { id: 2, displayName: "Mark", phoneNumber: "+2" },
    ];
    // 'anything' should not match the null-name participant
    expect(matchMember(participants, "anything")?.id).not.toBe(1);
    expect(matchMember(participants, "mark")?.id).toBe(2);
  });

  it("empty string display name is never matched on partial logic", () => {
    const participants = [
      { id: 1, displayName: "", phoneNumber: "+1" },
      { id: 2, displayName: "  ", phoneNumber: "+2" }, // whitespace only
    ];
    // An empty/whitespace display name must never match arbitrary input
    expect(matchMember(participants, "anythingAtAll")).toBeNull();
    expect(matchMember(participants, "hi")).toBeNull();
  });

  it("empty query returns null regardless of participants", () => {
    const participants = [{ id: 1, displayName: "Jake", phoneNumber: "+1" }];
    expect(matchMember(participants, "")).toBeNull();
    expect(matchMember(participants, "   ")).toBeNull();
  });

  it("partial match works when display name contains query", () => {
    const participants = [{ id: 1, displayName: "Jake Smith", phoneNumber: "+1" }];
    expect(matchMember(participants, "jake")?.id).toBe(1);
    expect(matchMember(participants, "smith")?.id).toBe(1);
  });

  it("partial match works when query contains display name", () => {
    const participants = [{ id: 1, displayName: "Mia", phoneNumber: "+1" }];
    expect(matchMember(participants, "Mia from work")?.id).toBe(1);
  });

  it("no participants yields null", () => {
    expect(matchMember([], "Jake")).toBeNull();
  });

  it("no participant has a matching name returns null", () => {
    const participants = [{ id: 1, displayName: "Sarah", phoneNumber: "+1" }];
    expect(matchMember(participants, "xyz")).toBeNull();
  });
});

// ── Per-member grace period enforcement ───────────────────────────────────────

describe("per-member grace period enforcement", () => {
  /**
   * Simulates the eligibility filter applied in getOutstandingBalancesForNudge.
   * Pure function, no DB — tests the filter logic in isolation.
   */
  function filterEligible(
    balances: Array<{
      userId: number;
      outstandingCents: number;
      oldestEstimateAt: Date | null;
      lastNudgedAt: Date | null;
    }>,
    now: Date = new Date(),
  ) {
    const graceCutoff = new Date(now.getTime() - PAYMENT_NUDGE_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const nudgeCutoff = new Date(now.getTime() - PAYMENT_NUDGE_REPEAT_DAYS * 24 * 60 * 60 * 1000);
    return balances.filter(
      (b) =>
        b.outstandingCents > 0 &&
        b.oldestEstimateAt !== null &&
        b.oldestEstimateAt < graceCutoff &&
        (!b.lastNudgedAt || b.lastNudgedAt < nudgeCutoff),
    );
  }

  const now = new Date("2025-01-10T12:00:00Z");

  it("member with old estimate past grace period is eligible", () => {
    const balances = [
      {
        userId: 1,
        outstandingCents: 30000,
        oldestEstimateAt: new Date("2025-01-06T00:00:00Z"), // 4 days old (> 3-day grace)
        lastNudgedAt: null,
      },
    ];
    expect(filterEligible(balances, now).map((b) => b.userId)).toEqual([1]);
  });

  it("member with estimate within grace period is NOT eligible, even if other members in same project have old estimates", () => {
    const balances = [
      {
        userId: 1,
        outstandingCents: 30000,
        oldestEstimateAt: new Date("2025-01-06T00:00:00Z"), // 4 days old — eligible
        lastNudgedAt: null,
      },
      {
        userId: 2,
        outstandingCents: 25000,
        oldestEstimateAt: new Date("2025-01-09T12:00:00Z"), // 12 hours old — in grace, NOT eligible
        lastNudgedAt: null,
      },
    ];
    const eligible = filterEligible(balances, now);
    expect(eligible.map((b) => b.userId)).toEqual([1]); // only user 1
    expect(eligible.find((b) => b.userId === 2)).toBeUndefined();
  });

  it("member with null oldestEstimateAt is never eligible (no estimates)", () => {
    const balances = [
      {
        userId: 1,
        outstandingCents: 30000,
        oldestEstimateAt: null,
        lastNudgedAt: null,
      },
    ];
    expect(filterEligible(balances, now)).toHaveLength(0);
  });

  it("member nudged within repeat window is not eligible", () => {
    const recentNudge = new Date("2025-01-08T12:00:00Z"); // 1.5 days ago (< 5-day repeat)
    const balances = [
      {
        userId: 1,
        outstandingCents: 30000,
        oldestEstimateAt: new Date("2025-01-01T00:00:00Z"),
        lastNudgedAt: recentNudge,
      },
    ];
    expect(filterEligible(balances, now)).toHaveLength(0);
  });

  it("member nudged more than 5 days ago is eligible again", () => {
    const oldNudge = new Date("2025-01-03T12:00:00Z"); // 6.5 days ago (> 5-day repeat)
    const balances = [
      {
        userId: 1,
        outstandingCents: 30000,
        oldestEstimateAt: new Date("2025-01-01T00:00:00Z"),
        lastNudgedAt: oldNudge,
      },
    ];
    expect(filterEligible(balances, now).map((b) => b.userId)).toEqual([1]);
  });

  it("fully-paid member is never eligible", () => {
    const balances = [
      {
        userId: 1,
        outstandingCents: 0,
        oldestEstimateAt: new Date("2025-01-01T00:00:00Z"),
        lastNudgedAt: null,
      },
    ];
    expect(filterEligible(balances, now)).toHaveLength(0);
  });
});

describe("nudge eligibility design invariants", () => {
  it("members with zero outstanding balance are not nudged", () => {
    const balances = [
      { userId: 1, outstandingCents: 0, lastNudgedAt: null },
      { userId: 2, outstandingCents: 30000, lastNudgedAt: null },
    ];
    const eligible = balances.filter((b) => b.outstandingCents > 0);
    expect(eligible.map((b) => b.userId)).toEqual([2]);
  });

  it("recently-nudged members are not nudged again", () => {
    const nudgeCutoff = new Date(Date.now() - PAYMENT_NUDGE_REPEAT_DAYS * 24 * 60 * 60 * 1000);
    const recentlNudged = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
    const oldNudge = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000); // 6 days ago

    const balances = [
      { userId: 1, outstandingCents: 30000, lastNudgedAt: recentlNudged },
      { userId: 2, outstandingCents: 30000, lastNudgedAt: oldNudge },
      { userId: 3, outstandingCents: 30000, lastNudgedAt: null },
    ];

    const eligible = balances.filter(
      (b) => b.outstandingCents > 0 && (!b.lastNudgedAt || b.lastNudgedAt < nudgeCutoff),
    );
    // Only users 2 (old nudge) and 3 (never nudged) are eligible.
    expect(eligible.map((b) => b.userId)).toEqual([2, 3]);
  });

  it("never-nudged members with outstanding balance are eligible after grace period", () => {
    const graceCutoff = new Date(Date.now() - PAYMENT_NUDGE_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const oldEstimate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days ago (past grace)
    const newEstimate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago (in grace)

    const entries = [
      { userId: 1, kind: "estimate", createdAt: oldEstimate },
      { userId: 2, kind: "estimate", createdAt: newEstimate },
    ];

    const eligible = entries.filter((e) => e.kind === "estimate" && e.createdAt < graceCutoff);
    expect(eligible.map((e) => e.userId)).toEqual([1]);
  });
});
