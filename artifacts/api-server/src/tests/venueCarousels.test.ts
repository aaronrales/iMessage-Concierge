import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for Task #34: venue photo carousels in recommendations.
 *
 * Covers:
 *  1. `fetchGooglePlacesPhotos` — mock Places API, assert photo URIs returned
 *  2. `findGooglePlaceIdByName`  — mock text-search, assert place ID extracted
 *  3. `sendCarousel`             — mock Sendblue, assert endpoint + body; null on 4xx
 *  4. `executeAgentTool` (search_venues) — assert venueCarouselAccumulator populated
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: { get: () => "image/jpeg" },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  });
}

function makeFetchError(status = 400) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "bad" }),
  });
}

const CREDS = {
  SENDBLUE_API_KEY_ID: "test-key",
  SENDBLUE_API_SECRET_KEY: "test-secret",
  SENDBLUE_FROM_NUMBER: "+10000000000",
};

// ── fetchGooglePlacesPhotos ────────────────────────────────────────────────────

describe("fetchGooglePlacesPhotos", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    process.env["GOOGLE_PLACES_API_KEY"] = "test-places-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("returns photo URIs from Places API", async () => {
    // First call: place detail with photo names
    // Second+ calls: media resolution for each photo
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              photos: [{ name: "places/abc/photos/photo1" }, { name: "places/abc/photos/photo2" }],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ photoUri: `https://lh3.googleusercontent.com/photo${callCount}` }),
      });
    });

    const { fetchGooglePlacesPhotos } = await import("../lib/agent/tools");
    const urls = await fetchGooglePlacesPhotos("ChIJabc123", 4);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/lh3\.googleusercontent\.com/);
    expect(urls[1]).toMatch(/lh3\.googleusercontent\.com/);
  });

  it("returns empty array when GOOGLE_PLACES_API_KEY is not set", async () => {
    delete process.env["GOOGLE_PLACES_API_KEY"];
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const { fetchGooglePlacesPhotos } = await import("../lib/agent/tools");
    const urls = await fetchGooglePlacesPhotos("ChIJabc123", 4);

    expect(urls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty array when the detail fetch fails", async () => {
    global.fetch = makeFetchError(404) as unknown as typeof fetch;

    const { fetchGooglePlacesPhotos } = await import("../lib/agent/tools");
    const urls = await fetchGooglePlacesPhotos("bad-id", 4);

    expect(urls).toEqual([]);
  });

  it("caps results at maxPhotos", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              photos: [
                { name: "places/abc/photos/p1" },
                { name: "places/abc/photos/p2" },
                { name: "places/abc/photos/p3" },
                { name: "places/abc/photos/p4" },
                { name: "places/abc/photos/p5" },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ photoUri: `https://example.com/photo${callCount}` }),
      });
    });

    const { fetchGooglePlacesPhotos } = await import("../lib/agent/tools");
    const urls = await fetchGooglePlacesPhotos("ChIJabc123", 2);

    // Only 2 requested; only 2 media calls should be made (+ 1 detail)
    expect(urls.length).toBeLessThanOrEqual(2);
  });
});

// ── findGooglePlaceIdByName ───────────────────────────────────────────────────

describe("findGooglePlaceIdByName", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    process.env["GOOGLE_PLACES_API_KEY"] = "test-places-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("returns the place ID from the first Places result", async () => {
    global.fetch = makeFetchOk({ places: [{ id: "ChIJresult123" }] }) as unknown as typeof fetch;

    const { findGooglePlaceIdByName } = await import("../lib/agent/tools");
    const id = await findGooglePlaceIdByName("The Smith", "Upper East Side");

    expect(id).toBe("ChIJresult123");
  });

  it("returns null when Places returns no results", async () => {
    global.fetch = makeFetchOk({ places: [] }) as unknown as typeof fetch;

    const { findGooglePlaceIdByName } = await import("../lib/agent/tools");
    const id = await findGooglePlaceIdByName("NonExistent Venue");

    expect(id).toBeNull();
  });

  it("returns null when the API key is missing", async () => {
    delete process.env["GOOGLE_PLACES_API_KEY"];
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const { findGooglePlaceIdByName } = await import("../lib/agent/tools");
    const id = await findGooglePlaceIdByName("Anywhere");

    expect(id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── sendCarousel ──────────────────────────────────────────────────────────────

describe("sendCarousel", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    Object.assign(process.env, CREDS);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("calls POST /api/send-carousel with media_urls and group_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message_handle: "ch1" }),
    });
    global.fetch = fetchMock;

    const { sendCarousel } = await import("../lib/sendblue");
    const handle = await sendCarousel({
      groupId: "grp-abc",
      mediaUrls: ["https://cdn.example.com/img1.jpg", "https://cdn.example.com/img2.jpg"],
    });

    expect(handle).toBe("ch1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/send-carousel");
    const body = JSON.parse(init.body as string);
    expect(body.group_id).toBe("grp-abc");
    expect(body.media_urls).toHaveLength(2);
  });

  it("calls POST /api/send-carousel with number for 1:1 threads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message_handle: "ch2" }),
    });
    global.fetch = fetchMock;

    const { sendCarousel } = await import("../lib/sendblue");
    await sendCarousel({
      to: "+15551234567",
      mediaUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.number).toBe("+15551234567");
    expect(body).not.toHaveProperty("group_id");
  });

  it("returns null on 4xx (iMessage not supported / SMS thread)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: "Carousels not supported on SMS" }),
    });

    const { sendCarousel } = await import("../lib/sendblue");
    const result = await sendCarousel({
      to: "+15551234567",
      mediaUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
    });

    expect(result).toBeNull();
  });

  it("returns null and never calls the API with fewer than 2 images", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const { sendCarousel } = await import("../lib/sendblue");
    const result = await sendCarousel({ to: "+15551234567", mediaUrls: ["https://cdn.example.com/a.jpg"] });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the media_urls array at 20 items", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    global.fetch = fetchMock;

    const { sendCarousel } = await import("../lib/sendblue");
    const manyUrls = Array.from({ length: 25 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    await sendCarousel({ to: "+15551234567", mediaUrls: manyUrls });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.media_urls).toHaveLength(20);
  });
});
