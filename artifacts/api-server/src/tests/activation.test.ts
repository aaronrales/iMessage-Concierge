import { describe, it, expect } from "vitest";
import { buildActivationSummary } from "../lib/agent/activation";

describe("buildActivationSummary", () => {
  it("returns zeros and null conversionRate when no users", () => {
    const result = buildActivationSummary(7, [], new Set());
    expect(result).toEqual({
      windowDays: 7,
      totalInvites: 0,
      bySource: { coldDm: 0, groupAdd: 0, other: 0 },
      onboardingCompleted: 0,
      conversionRate: null,
    });
  });

  it("splits sources correctly", () => {
    const users = [
      { id: 1, source: "cold_dm" },
      { id: 2, source: "cold_dm" },
      { id: 3, source: "group_add" },
      { id: 4, source: null },
      { id: 5, source: "referral" }, // unrecognized → other
    ];
    const result = buildActivationSummary(7, users, new Set());
    expect(result.bySource).toEqual({ coldDm: 2, groupAdd: 1, other: 2 });
    expect(result.totalInvites).toBe(5);
    expect(result.onboardingCompleted).toBe(0);
    expect(result.conversionRate).toBe(0);
  });

  it("counts only cohort members with onboarding_complete", () => {
    const users = [
      { id: 1, source: "cold_dm" },
      { id: 2, source: "group_add" },
      { id: 3, source: "cold_dm" },
    ];
    // id 99 is outside the cohort — must not count
    const completed = new Set([1, 3, 99]);
    const result = buildActivationSummary(7, users, completed);
    expect(result.onboardingCompleted).toBe(2);
    expect(result.conversionRate).toBeCloseTo(66.7, 0);
  });

  it("returns 100% when everyone converted", () => {
    const users = [{ id: 1, source: "cold_dm" }];
    const result = buildActivationSummary(7, users, new Set([1]));
    expect(result.conversionRate).toBe(100);
  });

  it("rounds conversionRate to one decimal", () => {
    // 1 of 3 → 33.333...% → should round to 33.3
    const users = [
      { id: 1, source: "cold_dm" },
      { id: 2, source: "cold_dm" },
      { id: 3, source: "cold_dm" },
    ];
    const result = buildActivationSummary(7, users, new Set([1]));
    expect(result.conversionRate).toBe(33.3);
  });

  it("respects windowDays parameter", () => {
    const result = buildActivationSummary(30, [], new Set());
    expect(result.windowDays).toBe(30);
  });

  it("buckets null source into other", () => {
    const users = [{ id: 1, source: null }];
    const result = buildActivationSummary(7, users, new Set());
    expect(result.bySource.other).toBe(1);
    expect(result.bySource.coldDm).toBe(0);
    expect(result.bySource.groupAdd).toBe(0);
  });
});
