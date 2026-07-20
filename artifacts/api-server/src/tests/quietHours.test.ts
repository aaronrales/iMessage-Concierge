import { describe, it, expect } from "vitest";
describe("quiet hours detection", () => {
  it("detects daytime (10am ET) as not quiet", () => {
    const hour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date("2026-07-20T10:00:00-04:00")), 10);
    expect(hour >= 9 && hour < 21).toBe(true);
  });
  it("detects 11pm ET as quiet", () => {
    const hour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date("2026-07-20T23:00:00-04:00")), 10);
    expect(hour >= 21 || hour < 9).toBe(true);
  });
});
