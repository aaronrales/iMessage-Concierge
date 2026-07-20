/**
 * Playbook templates for occasion timelines.
 *
 * Each template defines an ordered list of steps with lead-time offsets
 * (days before the project's event date) and action hints that drive the
 * scheduler's nudge messages to the organizer. Templates are the only config
 * needed to support a new occasion type -- no code changes in the scanner or
 * timeline module required.
 *
 * Convention:
 *   leadTimeDays > 0 → N days before the event date (the common case)
 *   leadTimeDays < 0 → N days AFTER the event date (post-event steps)
 *   leadTimeDays = 0 → on the event date itself
 */

export type CompletionTrigger =
  | "date_poll_closed"
  | "venue_poll_closed"
  | "booking_confirmed"
  | "plan_confirmed"
  | "none";

export interface PlaybookStep {
  /** Stable identifier for this step within the playbook (used as sourceStep in DB). */
  key: string;
  /** Human-readable title shown in the dashboard and organizer DM. */
  title: string;
  /**
   * Days before dateRangeStart when this step enters its lead window.
   * The scheduler sends the organizer a nudge when the current date
   * reaches (dateRangeStart - leadTimeDays).
   */
  leadTimeDays: number;
  /**
   * Short action hint for the scheduler message: one of a small vocabulary
   * that the nudge formatter maps to a natural-language draft.
   */
  actionHint: string;
  /**
   * Automatic completion trigger: when the underlying state satisfies this
   * condition, the daily scanner marks the step done without organizer input.
   */
  completionTrigger: CompletionTrigger;
}

export interface Playbook {
  /** Must match the occasion type slug stored in projectsTable.type. */
  type: string;
  steps: PlaybookStep[];
}

// ── Templates ─────────────────────────────────────────────────────────────────

const BACHELORETTE: Playbook = {
  type: "bachelorette",
  steps: [
    {
      key: "lock_date",
      title: "Lock in the date",
      leadTimeDays: 60,
      actionHint: "start_date_poll",
      completionTrigger: "date_poll_closed",
    },
    {
      key: "collect_budgets",
      title: "Collect budgets privately",
      leadTimeDays: 45,
      actionHint: "collect_budgets_via_private_input",
      completionTrigger: "none",
    },
    {
      key: "book_lodging",
      title: "Book lodging",
      leadTimeDays: 30,
      actionHint: "start_lodging_shortlist",
      completionTrigger: "booking_confirmed",
    },
    {
      key: "book_activities",
      title: "Book activities",
      leadTimeDays: 21,
      actionHint: "start_activities_shortlist",
      completionTrigger: "plan_confirmed",
    },
    {
      key: "final_headcount",
      title: "Confirm final headcount",
      leadTimeDays: 14,
      actionHint: "confirm_headcount",
      completionTrigger: "none",
    },
    {
      key: "collect_arrivals",
      title: "Collect arrival details",
      leadTimeDays: 10,
      actionHint: "collect_arrival_details",
      completionTrigger: "none",
    },
    {
      key: "week_of_logistics",
      title: "Week-of logistics",
      leadTimeDays: 7,
      actionHint: "send_week_of_details",
      completionTrigger: "none",
    },
  ],
};

const MILESTONE_BIRTHDAY: Playbook = {
  type: "milestone_birthday",
  steps: [
    {
      key: "lock_date",
      title: "Lock in the date",
      leadTimeDays: 45,
      actionHint: "start_date_poll",
      completionTrigger: "date_poll_closed",
    },
    {
      key: "collect_budgets",
      title: "Collect budgets privately",
      leadTimeDays: 35,
      actionHint: "collect_budgets_via_private_input",
      completionTrigger: "none",
    },
    {
      key: "book_venue",
      title: "Book venue or restaurant",
      leadTimeDays: 21,
      actionHint: "start_venue_shortlist",
      completionTrigger: "booking_confirmed",
    },
    {
      key: "organize_gift",
      title: "Organize group gift",
      leadTimeDays: 14,
      actionHint: "collect_gift_contributions",
      completionTrigger: "none",
    },
    {
      key: "week_of_logistics",
      title: "Week-of logistics",
      leadTimeDays: 7,
      actionHint: "send_week_of_details",
      completionTrigger: "none",
    },
  ],
};

const REUNION: Playbook = {
  type: "reunion",
  steps: [
    {
      key: "lock_date",
      title: "Lock in the date",
      leadTimeDays: 60,
      actionHint: "start_date_poll",
      completionTrigger: "date_poll_closed",
    },
    {
      key: "lock_location",
      title: "Decide on location",
      leadTimeDays: 45,
      actionHint: "start_location_poll",
      completionTrigger: "venue_poll_closed",
    },
    {
      key: "collect_budgets",
      title: "Collect budgets privately",
      leadTimeDays: 35,
      actionHint: "collect_budgets_via_private_input",
      completionTrigger: "none",
    },
    {
      key: "book_accommodation",
      title: "Book accommodation",
      leadTimeDays: 28,
      actionHint: "start_lodging_shortlist",
      completionTrigger: "booking_confirmed",
    },
    {
      key: "plan_activities",
      title: "Plan activities",
      leadTimeDays: 14,
      actionHint: "start_activities_shortlist",
      completionTrigger: "plan_confirmed",
    },
    {
      key: "collect_arrivals",
      title: "Collect arrival details",
      leadTimeDays: 10,
      actionHint: "collect_arrival_details",
      completionTrigger: "none",
    },
    {
      key: "week_of_logistics",
      title: "Week-of logistics",
      leadTimeDays: 7,
      actionHint: "send_week_of_details",
      completionTrigger: "none",
    },
  ],
};

const TRIP: Playbook = {
  type: "trip",
  steps: [
    {
      // Destination decision is deferred to a later task; placeholder for now
      // so the timeline is complete and the organizer knows it will be handled.
      key: "decide_destination",
      title: "Decide on destination",
      leadTimeDays: 60,
      actionHint: "placeholder_destination_decision",
      completionTrigger: "venue_poll_closed",
    },
    {
      key: "lock_dates",
      title: "Lock in travel dates",
      leadTimeDays: 50,
      actionHint: "start_date_poll",
      completionTrigger: "date_poll_closed",
    },
    {
      key: "collect_budgets",
      title: "Collect budgets privately",
      leadTimeDays: 40,
      actionHint: "collect_budgets_via_private_input",
      completionTrigger: "none",
    },
    {
      key: "book_accommodation",
      title: "Book accommodation",
      leadTimeDays: 30,
      actionHint: "start_lodging_shortlist",
      completionTrigger: "booking_confirmed",
    },
    {
      key: "plan_activities",
      title: "Plan activities",
      leadTimeDays: 14,
      actionHint: "start_activities_shortlist",
      completionTrigger: "plan_confirmed",
    },
    {
      key: "collect_arrivals",
      title: "Collect arrival details",
      leadTimeDays: 10,
      actionHint: "collect_arrival_details",
      completionTrigger: "none",
    },
    {
      key: "week_of_logistics",
      title: "Week-of logistics",
      leadTimeDays: 7,
      actionHint: "send_week_of_details",
      completionTrigger: "none",
    },
  ],
};

export const PLAYBOOKS: Record<string, Playbook> = {
  bachelorette: BACHELORETTE,
  milestone_birthday: MILESTONE_BIRTHDAY,
  reunion: REUNION,
  trip: TRIP,
};

/** Returns the playbook for the given occasion type slug, or null if none exists. */
export function getPlaybook(occasionType: string): Playbook | null {
  return PLAYBOOKS[occasionType] ?? null;
}

/**
 * Maps an actionHint slug to a human-readable nudge message sent to the
 * organizer's sidebar DM when a step enters its lead window.
 */
export function buildTimelineNudgeMessage(stepTitle: string, dueAt: Date | null, actionHint: string): string {
  const daysUntilDue = dueAt ? Math.round((dueAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;
  const timing =
    daysUntilDue === null
      ? ""
      : daysUntilDue <= 0
        ? " (due now)"
        : daysUntilDue === 1
          ? " (due tomorrow)"
          : ` (due in ${daysUntilDue} days)`;

  switch (actionHint) {
    case "start_date_poll":
      return `Timeline check${timing}: time to lock in a date for "${stepTitle}". Want me to run a poll with a few options?`;
    case "start_location_poll":
      return `Timeline check${timing}: "${stepTitle}" -- ready to start narrowing down where you're going?`;
    case "collect_budgets_via_private_input":
      return `Timeline check${timing}: "${stepTitle}" -- I can ask everyone their budget privately over DM and give you an anonymous summary. Want me to kick that off?`;
    case "start_lodging_shortlist":
      return `Timeline check${timing}: "${stepTitle}" -- ready to pull together a shortlist of lodging options for the group?`;
    case "start_venue_shortlist":
      return `Timeline check${timing}: "${stepTitle}" -- want me to pull together venue options for the group to pick from?`;
    case "start_activities_shortlist":
      return `Timeline check${timing}: "${stepTitle}" -- should I start putting together activity options for everyone to choose from?`;
    case "confirm_headcount":
      return `Timeline check${timing}: "${stepTitle}" -- do you have a final headcount? Let me know so I can update any reservations.`;
    case "collect_gift_contributions":
      return `Timeline check${timing}: "${stepTitle}" -- want me to quietly ask everyone what they'd like to chip in for the gift?`;
    case "send_week_of_details":
      return `Timeline check${timing}: "${stepTitle}" -- should I send the group a rundown of the plan for the week?`;
    case "collect_arrival_details":
      return `Timeline check${timing}: "${stepTitle}" -- want me to DM everyone privately and ask for their flight info and arrival time?`;
    case "placeholder_destination_decision":
      return `Timeline check${timing}: "${stepTitle}" -- the group hasn't settled on a destination yet. Want to start that conversation?`;
    default:
      return `Timeline check${timing}: time to work on "${stepTitle}". Want me to help get this moving?`;
  }
}
