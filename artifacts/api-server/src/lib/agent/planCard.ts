import sharp from "sharp";
import type { Plan } from "@workspace/db";
import { logger } from "../logger";
import { uploadMediaToSendblue } from "../sendblue";
import { describePlanSchedule } from "./calendar";

const CARD_WIDTH = 1000;
const CARD_HEIGHT = 560;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Wraps text into lines that fit roughly within `maxChars` per line, since
 * SVG <text> has no built-in wrapping.
 */
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Renders a plan confirmation card (venue, time, attendees, and a stylized
 * map-style panel) as a PNG. There is no venue geocoding available in this
 * build (Yelp lookups don't return coordinates and no maps integration is
 * wired up), so the "map thumbnail" is a decorative pin-on-grid graphic
 * rather than a real geocoded map -- it signals "here's where" visually
 * without asserting a location accuracy we don't have.
 */
export async function renderPlanCard(plan: Plan, attendeeNames: string[]): Promise<Buffer> {
  const venueLines = wrapText(plan.venue ?? "Venue TBD", 28);
  const when = describePlanSchedule(plan);
  const attendeesLine = attendeeNames.length > 0 ? attendeeNames.join(", ") : "Everyone in the group";

  const svg = `
<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f2937"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#2c3648" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)"/>

  <!-- Decorative "map" panel: not a real geocoded map, just a stylized pin. -->
  <g>
    <rect x="40" y="40" width="300" height="${CARD_HEIGHT - 80}" rx="18" fill="#0b1220"/>
    <rect x="40" y="40" width="300" height="${CARD_HEIGHT - 80}" rx="18" fill="url(#grid)"/>
    <circle cx="190" cy="${CARD_HEIGHT / 2 - 20}" r="16" fill="#ef4444"/>
    <path d="M190 ${CARD_HEIGHT / 2 - 4} l0 26" stroke="#ef4444" stroke-width="4" stroke-linecap="round"/>
    <circle cx="190" cy="${CARD_HEIGHT / 2 - 20}" r="6" fill="#0b1220"/>
  </g>

  <text x="380" y="130" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#9ca3af" letter-spacing="2">YOUR PLAN</text>
  <text x="380" y="180" font-family="Helvetica, Arial, sans-serif" font-size="42" font-weight="700" fill="#ffffff">${escapeXml(plan.title)}</text>

  ${venueLines
    .map(
      (line, i) =>
        `<text x="380" y="${240 + i * 46}" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#f9fafb">${escapeXml(line)}</text>`,
    )
    .join("\n  ")}

  <text x="380" y="${240 + venueLines.length * 46 + 50}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#a7f3d0">${escapeXml(when)}</text>

  <text x="380" y="${CARD_HEIGHT - 60}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#9ca3af">With: ${escapeXml(attendeesLine)}</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Renders and uploads the plan card, returning a Sendblue media URL. Returns
 * `null` on any failure (rendering or upload) so callers can fall back to a
 * text-only confirmation instead of breaking the plan-confirmation flow.
 */
export async function buildPlanCardMediaUrl(plan: Plan, attendeeNames: string[]): Promise<string | null> {
  try {
    const png = await renderPlanCard(plan, attendeeNames);
    return await uploadMediaToSendblue(png, `plan-${plan.id}.png`, "image/png");
  } catch (error) {
    logger.error({ error, planId: plan.id }, "Failed to render/upload plan card");
    return null;
  }
}
