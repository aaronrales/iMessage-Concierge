import type { Booking } from "@workspace/db";

/**
 * Best-effort reservation *search* deep links (Resy / OpenTable), built from
 * whatever the booking draft knows -- venue name, party size, and a
 * date/time if one was captured. These are NOT a real booking-partner
 * integration (that's out of scope for this phase): the link lands the
 * person on a search results page pre-filled with what we know, and they
 * still have to pick a specific table/time themselves. Every message that
 * includes one of these must say so explicitly -- never imply the table is
 * actually held.
 */

const RESY_BASE_URL = "https://resy.com";
const OPENTABLE_BASE_URL = "https://www.opentable.com";

// Default market for the Resy city-scoped search path when the booking
// doesn't specify one. This product currently only operates in NYC.
const DEFAULT_RESY_CITY_SLUG = "new-york-ny";

interface BookingDetails {
  venue?: string;
  city?: string; // Resy city slug, e.g. "new-york-ny" -- optional override.
  partySize?: number;
  when?: string; // ISO date/time string, if known.
}

function readBookingDetails(booking: Booking): BookingDetails {
  const raw = (booking.details ?? {}) as Record<string, unknown>;
  return {
    venue: typeof raw["venue"] === "string" ? (raw["venue"] as string) : undefined,
    city: typeof raw["city"] === "string" ? (raw["city"] as string) : undefined,
    partySize: typeof raw["partySize"] === "number" ? (raw["partySize"] as number) : undefined,
    when: typeof raw["when"] === "string" ? (raw["when"] as string) : undefined,
  };
}

function toDateOnly(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export interface ReservationLinks {
  resyUrl: string;
  openTableUrl: string;
}

/**
 * Builds Resy/OpenTable search links for a booking. Falls back to the
 * booking's `title` as the search term if `details.venue` wasn't set (the
 * LLM should populate `venue`, but titles are often the venue name too).
 */
export function buildReservationLinks(booking: Booking): ReservationLinks {
  const details = readBookingDetails(booking);
  const venue = details.venue?.trim() || booking.title;
  const citySlug = details.city?.trim() || DEFAULT_RESY_CITY_SLUG;
  const dateOnly = toDateOnly(details.when);

  const resyUrl = new URL(`${RESY_BASE_URL}/cities/${citySlug}/search`);
  resyUrl.searchParams.set("query", venue);
  if (dateOnly) resyUrl.searchParams.set("date", dateOnly);
  if (details.partySize) resyUrl.searchParams.set("seats", String(details.partySize));

  const openTableUrl = new URL(`${OPENTABLE_BASE_URL}/s`);
  openTableUrl.searchParams.set("term", venue);
  if (details.when) openTableUrl.searchParams.set("dateTime", details.when);
  if (details.partySize) openTableUrl.searchParams.set("covers", String(details.partySize));

  return { resyUrl: resyUrl.toString(), openTableUrl: openTableUrl.toString() };
}

/** Message copy for the links, explicit that this is a search, not a hold. */
export function describeReservationLinks(links: ReservationLinks): string {
  return `Search on Resy (${links.resyUrl}) or OpenTable (${links.openTableUrl}) to actually grab the table -- these are pre-filled searches, not a confirmed reservation.`;
}
