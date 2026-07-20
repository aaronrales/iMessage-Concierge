/**
 * Builds Airbnb / VRBO / Hotels.com search deep links pre-filled with
 * destination, check-in / check-out dates, and guest count.
 *
 * These are standard search-page URLs driven by publicly documented query
 * parameters — no API key or partner account required. The link lands the
 * recipient on a filtered search results page; they still have to pick a
 * specific listing themselves. Every message that includes one of these must
 * make clear it's a search link, not a confirmed booking.
 */

export interface LodgingLinks {
  airbnbUrl: string;
  vrboUrl: string;
  hotelsUrl: string;
}

export interface LodgingSearchParams {
  /** City name or neighborhood, e.g. "Nashville, TN" or "Scottsdale, AZ". */
  destination: string;
  /** Check-in date. Null when the project date range hasn't been set. */
  checkIn: Date | null;
  /** Check-out date. Null when the project date range hasn't been set. */
  checkOut: Date | null;
  /** Number of guests to pre-fill. */
  guests: number;
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Builds search deep links for Airbnb, VRBO, and Hotels.com.
 *
 * Airbnb:  /s/{destination}/homes?checkin=&checkout=&adults=
 * VRBO:    /search?destination=&adults=&startDate=&endDate=
 * Hotels:  /search.do?q-destination=&q-check-in=&q-check-out=&q-rooms=1&q-room-0-adults=
 */
export function buildLodgingLinks(params: LodgingSearchParams): LodgingLinks {
  const { destination, checkIn, checkOut, guests } = params;

  // ── Airbnb ──────────────────────────────────────────────────────────────────
  const airbnb = new URL(`https://www.airbnb.com/s/${encodeURIComponent(destination)}/homes`);
  if (checkIn) airbnb.searchParams.set("checkin", toISODate(checkIn));
  if (checkOut) airbnb.searchParams.set("checkout", toISODate(checkOut));
  airbnb.searchParams.set("adults", String(guests));

  // ── VRBO ─────────────────────────────────────────────────────────────────────
  const vrbo = new URL("https://www.vrbo.com/search");
  vrbo.searchParams.set("destination", destination);
  vrbo.searchParams.set("adults", String(guests));
  if (checkIn) vrbo.searchParams.set("startDate", toISODate(checkIn));
  if (checkOut) vrbo.searchParams.set("endDate", toISODate(checkOut));

  // ── Hotels.com ───────────────────────────────────────────────────────────────
  const hotels = new URL("https://www.hotels.com/search.do");
  hotels.searchParams.set("q-destination", destination);
  hotels.searchParams.set("q-rooms", "1");
  hotels.searchParams.set("q-room-0-adults", String(guests));
  if (checkIn) hotels.searchParams.set("q-check-in", toISODate(checkIn));
  if (checkOut) hotels.searchParams.set("q-check-out", toISODate(checkOut));

  return {
    airbnbUrl: airbnb.toString(),
    vrboUrl: vrbo.toString(),
    hotelsUrl: hotels.toString(),
  };
}

/** Formats cents as "$N" (no decimals when even) or "$N.NN". */
function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

/**
 * Builds the group-thread message that shares lodging options.
 * Includes per-person split and all three search links.
 * Caller is responsible for also recording the estimate in the ledger.
 */
export function buildLodgingGroupMessage(params: {
  links: LodgingLinks;
  destination: string;
  propertyName: string | null;
  perPersonCents: number | null;
  totalCents: number | null;
  headcount: number | null;
  nights: number | null;
}): string {
  const { links, destination, propertyName, perPersonCents, totalCents, headcount, nights } = params;

  const title = propertyName
    ? `Lodging option: ${propertyName}`
    : `Lodging search for ${destination}`;

  const costParts: string[] = [];
  if (perPersonCents) costParts.push(`${formatDollars(perPersonCents)}/person`);
  if (totalCents && headcount) costParts.push(`(${formatDollars(totalCents)} total ÷ ${headcount})`);
  else if (totalCents) costParts.push(`(${formatDollars(totalCents)} total)`);
  if (nights) costParts.push(`${nights} nights`);
  const costLine = costParts.length > 0 ? costParts.join(" · ") : null;

  const linkLines = [
    `Airbnb: ${links.airbnbUrl}`,
    `VRBO: ${links.vrboUrl}`,
    `Hotels: ${links.hotelsUrl}`,
  ];

  return [title, costLine, ...linkLines].filter(Boolean).join("\n");
}
