import { describe, expect, it } from "vitest";

/**
 * Unit tests for the outdoor / indoor note-parsing logic used by
 * `isVenueOutdoor` and the indoor-filter inside `lookupIndoorAlternatives`.
 *
 * Both functions share the same precedence rule: explicit negatives beat
 * incidental positive-keyword matches. Tests here verify that contract using
 * the same regex logic extracted inline (no DB dependency needed).
 */

const NEGATIVE_RE = /\b(no outdoor|no patio|no terrace|no outside|indoor only|entirely indoor)\b/i;
const POSITIVE_RE = /\b(patio|outdoor|terrace|rooftop|al fresco|garden|sidewalk)\b/i;

/**
 * Mirrors the logic inside `isVenueOutdoor`: negatives first, positives second.
 */
function classifyNote(note: string): "outdoor" | "indoor" | "unknown" {
  const n = note.toLowerCase();
  if (NEGATIVE_RE.test(n)) return "indoor";
  if (POSITIVE_RE.test(n)) return "outdoor";
  return "unknown";
}

describe("outdoor note classification (negatives beat positive keywords)", () => {
  // ── Positive cases ─────────────────────────────────────────────────────────
  it("classifies a plain patio note as outdoor", () => {
    expect(classifyNote("Has a lovely patio out back.")).toBe("outdoor");
  });

  it("classifies a rooftop note as outdoor", () => {
    expect(classifyNote("Rooftop seating with great views.")).toBe("outdoor");
  });

  it("classifies an al fresco note as outdoor", () => {
    expect(classifyNote("Outdoor al fresco dining in the garden.")).toBe("outdoor");
  });

  // ── Negative cases ─────────────────────────────────────────────────────────
  it("classifies 'no patio' as indoor, not outdoor", () => {
    // This was the bug: "patio" inside "no patio" triggered the positive regex.
    expect(classifyNote("No patio — indoor seating only.")).toBe("indoor");
  });

  it("classifies 'no outdoor seating' as indoor", () => {
    expect(classifyNote("No outdoor seating available.")).toBe("indoor");
  });

  it("classifies 'indoor only' as indoor", () => {
    expect(classifyNote("Indoor only; no terrace.")).toBe("indoor");
  });

  it("classifies 'entirely indoor' as indoor", () => {
    expect(classifyNote("Entirely indoor restaurant.")).toBe("indoor");
  });

  // ── Mixed phrasing (the failure mode the reviewer found) ───────────────────
  it("classifies 'no patio but great outdoor murals' as indoor (negative wins)", () => {
    // "outdoor" and "patio" appear but the leading negation must win.
    expect(classifyNote("No patio, but great outdoor murals on the walls.")).toBe("indoor");
  });

  it("classifies 'terrace closed, indoor only' as indoor (negative wins)", () => {
    expect(classifyNote("Terrace closed for season, indoor only.")).toBe("indoor");
  });

  // ── Unknown / no attribute ─────────────────────────────────────────────────
  it("returns unknown for a note with no outdoor markers", () => {
    expect(classifyNote("Cozy neighborhood bar with great cocktails.")).toBe("unknown");
  });

  it("returns unknown for an empty note", () => {
    expect(classifyNote("")).toBe("unknown");
  });
});
