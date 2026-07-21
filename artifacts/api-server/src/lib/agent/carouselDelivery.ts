import { db, threadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOpenPoll } from "./polls";
import { sendCarousel, sendDirectMessage, sendGroupMessage, uploadMediaToSendblue } from "../sendblue";
import { fetchGooglePlacesPhotos, findGooglePlaceIdByName, type VenueCarouselEntry } from "./tools";
import { logger } from "../logger";

/**
 * Sends a photo carousel for each shortlisted venue after the text reply.
 * Best-effort: any failure for an individual venue is logged and skipped —
 * a broken photo fetch must never delay or block the main reply flow.
 *
 * The carousels are intentionally fire-and-forget (`void`) from the call
 * site: they arrive as a follow-on burst of photos, the way a person might
 * text "here are some pics" right after a recommendation.
 */
export async function sendVenueCarousels(threadId: number, entries: VenueCarouselEntry[]): Promise<void> {
  try {
    const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
    if (!thread) return;

    // Photo-first voting: when there is an active poll, send each venue as an
    // individual photo bubble whose content is the venue name. A tapback
    // ("Loved "Lilia"") on that bubble is then picked up by parseTapback →
    // matchOption and registered as a vote — no separate voting UI needed.
    // When there is no active poll, fall back to the original multi-image carousel.
    const activePoll = await getOpenPoll(threadId);

    for (const entry of entries) {
      try {
        // Prefer the stored Google Place ID; fall back to a text search when the
        // venue was added to the corpus before the field was populated.
        let placeId = entry.googlePlaceId;
        if (!placeId) {
          placeId = await findGooglePlaceIdByName(entry.venueName);
          if (!placeId) {
            logger.debug({ venueName: entry.venueName }, "No Google Place ID found; skipping photo for this venue");
            continue;
          }
        }

        // Voting mode only needs 1 photo; carousel mode needs ≥ 2.
        const neededPhotos = activePoll ? 1 : 2;
        const photoUrls = await fetchGooglePlacesPhotos(placeId, 4);

        if (photoUrls.length < 1) {
          logger.debug({ venueName: entry.venueName }, "No photos returned; skipping this venue");
          continue;
        }

        // Google Places photo URIs are short-lived and Google-hosted. Sendblue
        // requires its own CDN-hosted URLs, so we download and upload each.
        // Stop uploading once we have enough for the chosen send mode.
        const uploadedUrls: string[] = [];
        for (const photoUrl of photoUrls) {
          const imgResp = await fetch(photoUrl);
          if (!imgResp.ok) continue;
          const buffer = Buffer.from(await imgResp.arrayBuffer());
          const contentType = imgResp.headers.get("content-type") ?? "image/jpeg";
          const ext = contentType.includes("png") ? "png" : "jpg";
          const safeName = entry.venueName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
          const uploaded = await uploadMediaToSendblue(buffer, `${safeName}-${uploadedUrls.length}.${ext}`, contentType);
          if (uploaded) {
            uploadedUrls.push(uploaded);
            if (uploadedUrls.length >= neededPhotos) break;
          }
        }

        if (uploadedUrls.length < 1) {
          logger.debug({ venueName: entry.venueName }, "No photos uploaded; skipping this venue");
          continue;
        }

        if (activePoll) {
          // Individual bubble per venue: tapback on it = vote for that venue.
          if (thread.isGroup && thread.sendblueGroupId) {
            await sendGroupMessage({ groupId: thread.sendblueGroupId, content: entry.venueName, mediaUrl: uploadedUrls[0] });
          } else if (thread.primaryPhoneNumber) {
            await sendDirectMessage({ to: thread.primaryPhoneNumber, content: entry.venueName, mediaUrl: uploadedUrls[0] });
          }
        } else {
          if (uploadedUrls.length < 2) {
            logger.debug({ venueName: entry.venueName }, "Insufficient photos for carousel; skipping");
            continue;
          }
          if (thread.isGroup && thread.sendblueGroupId) {
            await sendCarousel({ groupId: thread.sendblueGroupId, mediaUrls: uploadedUrls });
          } else if (thread.primaryPhoneNumber) {
            await sendCarousel({ to: thread.primaryPhoneNumber, mediaUrls: uploadedUrls });
          }
        }
      } catch (error) {
        logger.warn({ error, venueName: entry.venueName }, "Failed to send venue photo; continuing with remaining venues");
      }
    }
  } catch (error) {
    // Outer guard: thread lookup or setup failure must never surface as an
    // unhandled rejection since this function is always called fire-and-forget.
    logger.warn({ error, threadId }, "sendVenueCarousels failed during setup; skipping all carousels for this turn");
  }
}
