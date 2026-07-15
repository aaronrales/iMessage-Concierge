import type { Plan } from "@workspace/db";

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

/** Human-friendly summary line for a confirmed plan, used in the confirmation text. */
export function describePlanSchedule(plan: Plan): string {
  const when = plan.scheduledFor
    ? plan.scheduledFor.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "a time we still need to pin down";
  return plan.venue ? `${when} at ${plan.venue}` : when;
}
