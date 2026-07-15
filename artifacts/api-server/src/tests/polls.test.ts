import { describe, it, expect } from "vitest";
import { matchOption, matchOptions, parseTapback } from "../lib/agent/polls";

const OPTIONS = [
  { id: 1, label: "Thai food" },
  { id: 2, label: "Italian" },
  { id: 3, label: "Mexican" },
];

describe("matchOption", () => {
  it("matches an exact label (case-insensitive)", () => {
    expect(matchOption("Thai food", OPTIONS)?.id).toBe(1);
    expect(matchOption("ITALIAN", OPTIONS)?.id).toBe(2);
    expect(matchOption("mexican", OPTIONS)?.id).toBe(3);
  });

  it("matches when the message contains the label as a substring", () => {
    expect(matchOption("I'll go with Italian please", OPTIONS)?.id).toBe(2);
    expect(matchOption("Thai food sounds great!", OPTIONS)?.id).toBe(1);
  });

  it("matches by numeric shorthand (1-based)", () => {
    expect(matchOption("1", OPTIONS)?.id).toBe(1);
    expect(matchOption("2", OPTIONS)?.id).toBe(2);
    expect(matchOption("3", OPTIONS)?.id).toBe(3);
  });

  it("returns null for out-of-range numbers", () => {
    expect(matchOption("0", OPTIONS)).toBeNull();
    expect(matchOption("4", OPTIONS)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchOption("sushi", OPTIONS)).toBeNull();
    expect(matchOption("", OPTIONS)).toBeNull();
  });
});

describe("matchOptions", () => {
  const DATE_OPTIONS = [
    { id: 1, label: "Friday 7pm" },
    { id: 2, label: "Saturday 2pm" },
    { id: 3, label: "Sunday noon" },
  ];

  it("returns all options for 'any' / 'all' catch-all phrases", () => {
    expect(matchOptions("any of them", DATE_OPTIONS).map((o) => o.id)).toEqual([1, 2, 3]);
    expect(matchOptions("all work for me", DATE_OPTIONS).map((o) => o.id)).toEqual([1, 2, 3]);
    expect(matchOptions("whatever works", DATE_OPTIONS).map((o) => o.id)).toEqual([1, 2, 3]);
  });

  it("splits on commas and 'and' to match multiple options", () => {
    const ids = matchOptions("Friday 7pm and Saturday 2pm", DATE_OPTIONS).map((o) => o.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
  });

  it("splits on numeric shorthand list", () => {
    const ids = matchOptions("1, 3", DATE_OPTIONS).map((o) => o.id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });

  it("falls back to treating the whole message as a single selection", () => {
    const ids = matchOptions("Friday 7pm", DATE_OPTIONS).map((o) => o.id);
    expect(ids).toEqual([1]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchOptions("maybe wednesday", DATE_OPTIONS)).toEqual([]);
    expect(matchOptions("", DATE_OPTIONS)).toEqual([]);
  });

  it("deduplicates when the same full label appears multiple times in a message", () => {
    // "Friday 7pm and Friday 7pm" names the same option twice; result should
    // contain only one entry for option 1, not two.
    const ids = matchOptions("Friday 7pm and Friday 7pm", DATE_OPTIONS).map((o) => o.id);
    expect(ids.filter((id) => id === 1).length).toBe(1);
    expect(ids.length).toBe(1);
  });
});

describe("parseTapback", () => {
  it("parses a positive tapback", () => {
    const result = parseTapback('Loved "Thai food?"');
    expect(result).not.toBeNull();
    expect(result?.quotedContent).toBe("Thai food?");
    expect(result?.isPositive).toBe(true);
  });

  it("parses a negative tapback", () => {
    const result = parseTapback('Disliked "Thai food?"');
    expect(result).not.toBeNull();
    expect(result?.isPositive).toBe(false);
  });

  it("parses 'Liked' as positive", () => {
    expect(parseTapback('Liked "1. Thai"')?.isPositive).toBe(true);
  });

  it("parses 'Emphasized' as positive", () => {
    expect(parseTapback('Emphasized "Saturday 7pm"')?.isPositive).toBe(true);
  });

  it("parses 'Questioned' as negative", () => {
    expect(parseTapback('Questioned "Saturday 7pm"')?.isPositive).toBe(false);
  });

  it("returns null for a non-tapback message", () => {
    expect(parseTapback("sounds great")).toBeNull();
    expect(parseTapback("I voted for 1")).toBeNull();
    expect(parseTapback("")).toBeNull();
  });

  it("handles curly quotes in the quoted content", () => {
    const result = parseTapback("Loved \u201cThai food?\u201d");
    expect(result?.quotedContent).toBe("Thai food?");
    expect(result?.isPositive).toBe(true);
  });
});
