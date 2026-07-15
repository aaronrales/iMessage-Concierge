import type { Plan } from "@workspace/db";

/**
 * The IANA timezone used for all date formatting and scheduled-job times.
 * Overridable via `CONCIERGE_TIMEZONE` env var for future multi-city expansion;
 * defaults to `America/New_York` since that is where all current groups are.
 */
export const CONCIERGE_TIMEZONE = process.env["CONCIERGE_TIMEZONE"] ?? "America/New_York";

const GOOGLE_CALENDAR_BASE_URL = "https://calendar.google.com/calendar/render";

function toGoogleCalendarDate(date: Date, durationMs: number): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const end = new Date(date.getTime() + durationMs);
  return `${fmt(date)}/${fmt(end)}`;
}

const DEFAULT_PLAN_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Builds a real, clickable "add to Google Calendar" link for a confirmed
 * plan -- no OAuth, no hosting, works from a plain text message. Returns
 * `null` if the plan has no scheduled time yet (nothing to put on a calendar).
 */
export function buildGoogleCalendarLink(plan: Plan): string | null {
  if (!plan.scheduledFor) return null;

  const url = new URL(GOOGLE_CALENDAR_BASE_URL);
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", plan.title);
  url.searchParams.set("dates", toGoogleCalendarDate(plan.scheduledFor, DEFAULT_PLAN_DURATION_MS));
  if (plan.venue) {
    url.searchParams.set("location", plan.venue);
  }
  url.searchParams.set("details", "Planned with your AI concierge.");
  return url.toString();
}

/**
 * Generates a valid RFC 5545 `.ics` string for a confirmed plan. Works natively
 * with Apple Calendar on iPhone -- tap the link, tap "Add to Calendar", done.
 * Returns `null` if the plan has no scheduled time yet.
 */
export function buildIcsString(plan: Plan): string | null {
  if (!plan.scheduledFor) return null;

  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const end = new Date(plan.scheduledFor.getTime() + DEFAULT_PLAN_DURATION_MS);
  const now = new Date();

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AI Concierge//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:plan-${plan.id}@concierge`,
    `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(plan.scheduledFor)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${plan.title}`,
    plan.venue ? `LOCATION:${plan.venue}` : "",
    "DESCRIPTION:Planned with your AI concierge.",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.join("\r\n");
}

/**
 * Builds a public URL for the plan's `.ics` file, served by this API server.
 * Requires `PUBLIC_API_URL` env var to be set to the full base URL of this
 * server (e.g. `https://abc.replit.app/api-server`). Returns `null` when unset
 * so callers can gracefully degrade to the Google Calendar link only.
 */
export function buildIcsUrl(planId: number): string | null {
  const base = process.env["PUBLIC_API_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/api/plans/${planId}/calendar.ics`;
}

/** Human-friendly summary line for a confirmed plan, used in the confirmation text.
 *  Always formats in `CONCIERGE_TIMEZONE` so the time is correct for NYC groups
 *  regardless of where the server is running. */
export function describePlanSchedule(plan: Plan): string {
  const when = plan.scheduledFor
    ? plan.scheduledFor.toLocaleString("en-US", {
        timeZone: CONCIERGE_TIMEZONE,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "a time we still need to pin down";
  return plan.venue ? `${when} at ${plan.venue}` : when;
}
