import type { ProjectProposal } from "@workspace/db";
import {
  releaseProposal,
  type PollProposalContent,
  type VenueShortlistProposalContent,
  type ItineraryProposalContent,
} from "./projectProposals";
import { sendToThread } from "./delivery";
import { createPoll } from "./polls";
import { createPlanInProject, getOrCreateActivePlan, setPlanScheduledFor, setPlanVenue } from "./plans";
import { getActiveProject } from "./projects";
import { scheduleNonVoterNudge } from "./scheduler";
import { sendVenueCarousels } from "./carouselDelivery";
import { logger } from "../logger";

/**
 * Releases an organizer-approved proposal to the group thread. Mirrors the
 * normal group-turn delivery logic for each proposal type.
 */
export async function releasePendingProposalToGroup(
  proposal: ProjectProposal,
  groupThreadId: number,
  organizerThreadId: number,
): Promise<void> {
  // Mark released before sending to fail toward under- not double-sending.
  await releaseProposal(proposal.id);
  const content = proposal.proposalContent as unknown;

  if (proposal.proposalType === "poll") {
    const { question, options, kind, optionDates, reply } = content as PollProposalContent;
    await sendToThread(groupThreadId, reply);
    const plan = await getOrCreateActivePlan(groupThreadId, question);
    const { poll, options: pollOptions } = await createPoll(groupThreadId, question, options, {
      kind,
      planId: plan.id,
      optionDates: (optionDates as (string | null)[]).map((d) => {
        if (!d) return null;
        const parsed = new Date(d);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }),
    });
    await scheduleNonVoterNudge(groupThreadId, poll.id);
    for (const [index, option] of pollOptions.entries()) {
      await sendToThread(groupThreadId, `${index + 1}. ${option.label}`);
    }
  } else if (proposal.proposalType === "venue_shortlist") {
    const { reply, venueCarousels: carousels } = content as unknown as VenueShortlistProposalContent;
    await sendToThread(groupThreadId, reply);
    if (Array.isArray(carousels) && carousels.length > 0) {
      void sendVenueCarousels(groupThreadId, carousels);
    }
  } else if (proposal.proposalType === "itinerary") {
    const { reply, events } = content as unknown as ItineraryProposalContent;
    await sendToThread(groupThreadId, reply);
    // Materialise each event as a child Plan of the project so itinerary
    // rendering, calendar output, weather rescue, and feedback prompts all
    // find structured rows to act on.
    const project = await getActiveProject(groupThreadId);
    for (const event of events) {
      try {
        const plan = await createPlanInProject(proposal.projectId, groupThreadId, event.title);
        if (event.venue) {
          await setPlanVenue(plan.id, event.venue);
        }
        if (project?.dateRangeStart) {
          const scheduledFor = new Date(
            project.dateRangeStart.getTime() + event.dayOffset * 24 * 60 * 60 * 1000,
          );
          await setPlanScheduledFor(plan.id, scheduledFor);
        }
      } catch (err) {
        logger.error(
          { err, proposalId: proposal.id, eventTitle: event.title },
          "Failed to create plan from approved itinerary event; continuing with rest",
        );
      }
    }
  } else {
    // message
    const { reply } = content as { reply: string };
    await sendToThread(groupThreadId, reply);
  }

  await sendToThread(organizerThreadId, "Sent to the group.");
}
