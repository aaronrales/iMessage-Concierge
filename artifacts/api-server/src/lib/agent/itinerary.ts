import { and, eq, inArray } from "drizzle-orm";
import { db, plansTable, projectsTable } from "@workspace/db";
import type { Plan } from "@workspace/db";

/**
 * Timezone used for all itinerary display formatting. Plans are stored in UTC;
 * this converts them to Eastern time for labeling and grouping into calendar days.
 */
const DISPLAY_TZ = "America/New_York";

export interface ItineraryEvent {
  planId: number;
  title: string;
  venue: string | null;
  scheduledFor: Date;
  status: string;
  attendeeCount: number;
}

export interface ItineraryDay {
  /** The calendar date object (UTC midnight of the local day — use for sorting only). */
  date: Date;
  /** Human-readable label for the day, e.g. "Friday, June 14". */
  dayLabel: string;
  events: ItineraryEvent[];
}

export interface Itinerary {
  projectId: number;
  projectType: string;
  honoree: string | null;
  destination: string | null;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
  days: ItineraryDay[];
  totalEvents: number;
}

/** Returns a stable sort key for a date in the display timezone: "YYYY-MM-DD". */
function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date); // en-CA gives ISO-style YYYY-MM-DD natively
}

/** Human-readable day label in the display timezone, e.g. "Friday, June 14". */
function dayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Formats a time in the display timezone, e.g. "7:30 PM".
 */
export function formatItineraryTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/**
 * Builds a structured day-by-day itinerary for a project.
 *
 * Only includes confirmed and done plans that have a scheduled date. Plans are
 * grouped by calendar day in DISPLAY_TZ and sorted chronologically within each
 * day. The result is always generated fresh from the current DB state — never
 * cached — so it reflects the latest plan changes automatically.
 *
 * Returns null when the project doesn't exist.
 */
export async function buildItinerary(projectId: number): Promise<Itinerary | null> {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!project) return null;

  // Include confirmed and done plans (skip proposed/deciding/cancelled —
  // they haven't been agreed on yet).
  const plans = await db
    .select()
    .from(plansTable)
    .where(
      and(
        eq(plansTable.projectId, projectId),
        inArray(plansTable.status, ["confirmed", "done"]),
      ),
    );

  // Drop plans without a scheduled time — they can't be placed on a calendar.
  const scheduled = plans.filter(
    (p): p is Plan & { scheduledFor: Date } => p.scheduledFor !== null,
  );
  scheduled.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());

  // Group into calendar days (keyed by YYYY-MM-DD in display timezone).
  const dayEventMap = new Map<string, ItineraryEvent[]>();
  const dayRepresentativeDate = new Map<string, Date>();

  for (const plan of scheduled) {
    const key = dayKey(plan.scheduledFor);
    if (!dayEventMap.has(key)) {
      dayEventMap.set(key, []);
      dayRepresentativeDate.set(key, plan.scheduledFor);
    }
    dayEventMap.get(key)!.push({
      planId: plan.id,
      title: plan.title,
      venue: plan.venue,
      scheduledFor: plan.scheduledFor,
      status: plan.status,
      attendeeCount: Array.isArray(plan.attendeeUserIds) ? plan.attendeeUserIds.length : 0,
    });
  }

  // Sort days chronologically (YYYY-MM-DD keys sort lexicographically).
  const days: ItineraryDay[] = Array.from(dayEventMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, events]) => ({
      date: dayRepresentativeDate.get(key)!,
      dayLabel: dayLabel(dayRepresentativeDate.get(key)!),
      events,
    }));

  return {
    projectId,
    projectType: project.type,
    honoree: project.honoree,
    destination: project.destination ?? null,
    dateRangeStart: project.dateRangeStart,
    dateRangeEnd: project.dateRangeEnd,
    days,
    totalEvents: scheduled.length,
  };
}

/**
 * Renders an itinerary as a concise iMessage-friendly text summary.
 *
 * Format:
 *   📋 bachelorette for Sarah in Nashville
 *
 *   📅 Friday, June 14
 *     7:00 PM — Welcome Dinner at The Catbird Seat
 *
 *   📅 Saturday, June 15
 *    11:00 AM — Spa at Woodhouse Day Spa
 *     7:30 PM — Night Out at FGL House
 */
export function renderItineraryAsText(itinerary: Itinerary): string {
  if (itinerary.days.length === 0) {
    return "No confirmed events are scheduled yet — once plans are locked in they'll appear here.";
  }

  const typeLine = itinerary.projectType.replace(/_/g, " ");
  const honoreeClause = itinerary.honoree ? ` for ${itinerary.honoree}` : "";
  const destinationClause = itinerary.destination ? ` in ${itinerary.destination}` : "";

  const lines: string[] = [`📋 ${typeLine}${honoreeClause}${destinationClause}`];

  for (const day of itinerary.days) {
    lines.push(`\n📅 ${day.dayLabel}`);
    for (const event of day.events) {
      const time = formatItineraryTime(event.scheduledFor);
      const venue = event.venue ? ` at ${event.venue}` : "";
      lines.push(`  ${time} — ${event.title}${venue}`);
    }
  }

  return lines.join("\n");
}
