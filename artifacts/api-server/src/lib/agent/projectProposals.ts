import { and, asc, eq } from "drizzle-orm";
import { db, projectProposalsTable, type ProjectProposal } from "@workspace/db";

/**
 * Organizer-approval gate for group-visible proposals.
 *
 * When the agent is about to send something significant to a group thread —
 * a venue shortlist, a poll, or a decisive message — and the project has an
 * organizer, the output is held here first. The organizer sees a DM preview
 * and either approves (which triggers release to the group) or rejects/edits.
 *
 * `proposalContent` shapes per type (stored as JSONB):
 *   poll:            { question, options, kind, optionDates, reply }
 *   venue_shortlist: { reply, venueCarousels }
 *   message:         { reply }
 */

export type ProposalType = "poll" | "venue_shortlist" | "message";

export interface PollProposalContent {
  question: string;
  options: string[];
  kind: "choice" | "date";
  optionDates: (string | null)[];
  reply: string;
}

export interface VenueShortlistProposalContent {
  reply: string;
  /** venueId is optional: present for corpus hits, absent for Google Places fallback results. */
  venueCarousels: { venueId?: number; venueName: string; googlePlaceId: string | null }[];
}

export interface MessageProposalContent {
  reply: string;
}

export type ProposalContent = PollProposalContent | VenueShortlistProposalContent | MessageProposalContent;

/** Stores a new pending proposal. Must be called before sending the organizer DM. */
export async function createProposal(
  projectId: number,
  groupThreadId: number,
  proposalType: ProposalType,
  proposalContent: ProposalContent,
): Promise<ProjectProposal> {
  const [row] = await db
    .insert(projectProposalsTable)
    .values({ projectId, groupThreadId, proposalType, proposalContent })
    .returning();
  if (!row) throw new Error("Failed to create project proposal");
  return row;
}

/**
 * The oldest unresolved proposal for a project. The organizer's sidebar
 * always shows (and awaits approval on) the next-in-queue proposal so the
 * queue drains in order.
 */
export async function getOldestPendingProposal(projectId: number): Promise<ProjectProposal | null> {
  const [row] = await db
    .select()
    .from(projectProposalsTable)
    .where(and(eq(projectProposalsTable.projectId, projectId), eq(projectProposalsTable.status, "pending")))
    .orderBy(asc(projectProposalsTable.createdAt))
    .limit(1);
  return row ?? null;
}

/** Marks a pending proposal as approved (organizer said yes). */
export async function approveProposal(proposalId: number, organizerReply: string): Promise<ProjectProposal> {
  const [row] = await db
    .update(projectProposalsTable)
    .set({ status: "approved", organizerReply })
    .where(eq(projectProposalsTable.id, proposalId))
    .returning();
  if (!row) throw new Error("Proposal not found");
  return row;
}

/** Marks a pending proposal as rejected (organizer said no). */
export async function rejectProposal(proposalId: number, organizerReply: string): Promise<ProjectProposal> {
  const [row] = await db
    .update(projectProposalsTable)
    .set({ status: "rejected", organizerReply })
    .where(eq(projectProposalsTable.id, proposalId))
    .returning();
  if (!row) throw new Error("Proposal not found");
  return row;
}

/** Marks a proposal as released after it has been sent to the group. */
export async function releaseProposal(proposalId: number): Promise<void> {
  await db
    .update(projectProposalsTable)
    .set({ status: "released", releasedAt: new Date() })
    .where(eq(projectProposalsTable.id, proposalId));
}

/**
 * Builds the DM preview text the organizer sees when a new proposal is
 * queued. Shows a short summary of what would be sent to the group and asks
 * for approval.
 */
export function buildOrganizerPreviewMessage(type: ProposalType, content: ProposalContent): string {
  if (type === "poll") {
    const p = content as PollProposalContent;
    const optionLines = p.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n");
    return (
      `Here's what I'd send to the group -- let me know if this looks good (reply "yes" or "approve") or give me feedback:\n\n` +
      `"${p.reply}"\n\n` +
      `Poll options:\n${optionLines}`
    );
  }
  if (type === "venue_shortlist") {
    const v = content as VenueShortlistProposalContent;
    const names = v.venueCarousels.map((e) => e.venueName).join(", ");
    return (
      `Here's what I'd send to the group -- approve or give me feedback:\n\n` +
      `"${v.reply}"${names ? `\n\n(Venues: ${names})` : ""}`
    );
  }
  // message
  const m = content as MessageProposalContent;
  return (
    `Here's what I'd send to the group -- approve (reply "yes") or give me feedback:\n\n"${m.reply}"`
  );
}

/**
 * Simple heuristic: does the organizer's reply intent read as approval?
 * Used as a fast-path before loading the LLM.
 */
export function isApprovalReply(text: string): boolean {
  return /\b(yes|approve[d]?|looks good|send it|go for it|perfect|great|sounds good|lgtm|yep|yup|👍|sure|ok(ay)?)\b/i.test(text.trim());
}

/**
 * Simple heuristic: does the organizer's reply intent read as rejection?
 */
export function isRejectionReply(text: string): boolean {
  return /\b(no|nope|don'?t|stop|cancel|skip|not (yet|now)|hold off|wait|change|edit|update|different|try again|redo|rewrite)\b/i.test(text.trim());
}

/**
 * Returns true when this looks like an organizer tiebreak override, e.g.
 * "go with the rooftop one" / "pick Lilia" / "choose option 2".
 * Combined with option matching in the polls module to resolve the specific option.
 */
export function isTiebreakOverride(text: string): boolean {
  return /\b(go with|pick|choose|select|do the|let'?s do|I('d)? (say|vote|pick)|use|take|just do)\b/i.test(text.trim());
}
