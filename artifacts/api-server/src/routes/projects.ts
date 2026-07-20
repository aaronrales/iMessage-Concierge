import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { buildItinerary, formatItineraryTime } from "../lib/agent/itinerary";

const router: IRouter = Router();

const ProjectIdParam = z.object({ id: z.coerce.number().int() });

const DISPLAY_TZ = "America/New_York";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateRange(start: Date | null, end: Date | null): string {
  const fmtLong = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: DISPLAY_TZ,
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(d);
  const fmtShort = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: DISPLAY_TZ,
      month: "long",
      day: "numeric",
    }).format(d);

  if (start && end) return `${fmtShort(start)} – ${fmtLong(end)}`;
  if (start) return fmtLong(start);
  return "Dates TBD";
}

/**
 * GET /projects/:id/itinerary
 *
 * Renders a print-friendly HTML itinerary for the project's confirmed plans,
 * grouped by calendar day. Always generated fresh from DB — reflects latest
 * plan state without manual regeneration.
 *
 * Designed for:
 * - Sharing as a link in the group thread
 * - Browser print-to-PDF (clean one-page layout with @media print rules)
 * - Dashboard "Itinerary" button opening in a new tab
 */
router.get("/projects/:id/itinerary", async (req, res): Promise<void> => {
  const params = ProjectIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).send("Invalid project ID");
    return;
  }

  const itinerary = await buildItinerary(params.data.id);
  if (!itinerary) {
    res.status(404).send("Project not found");
    return;
  }

  const typeLine = itinerary.projectType.replace(/_/g, " ");
  const titleParts = [
    typeLine,
    itinerary.honoree ? `for ${itinerary.honoree}` : null,
  ].filter(Boolean);
  const title = titleParts.join(" ");
  const dateRange = formatDateRange(itinerary.dateRangeStart, itinerary.dateRangeEnd);

  // ── Build schedule rows ────────────────────────────────────────────────────
  const scheduleHtml =
    itinerary.days.length === 0
      ? `<p class="empty">No confirmed events scheduled yet.</p>`
      : `<table>
          <tbody>
            ${itinerary.days
              .flatMap((day) => [
                `<tr class="day-header"><td colspan="3"><span class="day-label">${escapeHtml(day.dayLabel)}</span></td></tr>`,
                ...day.events.map(
                  (event) => `<tr class="event-row">
                    <td class="time">${escapeHtml(formatItineraryTime(event.scheduledFor))}</td>
                    <td class="event-title">
                      ${escapeHtml(event.title)}
                      ${event.status === "done" ? '<span class="done-badge">✓</span>' : ""}
                    </td>
                    <td class="venue">${event.venue ? escapeHtml(event.venue) : '<span class="tbd">TBD</span>'}</td>
                  </tr>`,
                ),
              ])
              .join("\n")}
          </tbody>
        </table>`;

  const destinationHtml = itinerary.destination
    ? `<span class="destination">📍 ${escapeHtml(itinerary.destination)}</span>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — Itinerary</title>
  <style>
    /* ── Reset & base ─────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.5;
      color: #111;
      background: #fff;
      padding: 52px 60px;
      max-width: 860px;
      margin: 0 auto;
    }

    /* ── Header ──────────────────────────────────────────────── */
    .header {
      margin-bottom: 40px;
      padding-bottom: 24px;
      border-bottom: 2px solid #111;
    }
    .trip-label {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: #888;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -0.025em;
      line-height: 1.15;
      text-transform: capitalize;
      margin-bottom: 12px;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
      font-size: 14px;
      color: #555;
    }
    .date-range { font-weight: 600; color: #333; }
    .destination {
      font-weight: 600;
      color: #1a7a4a;
    }

    /* ── Schedule table ──────────────────────────────────────── */
    table { width: 100%; border-collapse: collapse; }

    .day-header td {
      padding: 28px 0 8px;
      border-bottom: 1.5px solid #ddd;
    }
    .day-label {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #444;
    }

    .event-row td {
      padding: 13px 0;
      vertical-align: top;
      border-bottom: 1px solid #f2f2f2;
    }
    .event-row:last-child td { border-bottom: none; }

    .time {
      width: 86px;
      font-size: 13px;
      font-weight: 600;
      color: #666;
      white-space: nowrap;
      padding-right: 20px;
    }
    .event-title {
      font-size: 15px;
      font-weight: 600;
      padding-right: 24px;
    }
    .done-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 800;
      color: #1a7a4a;
      margin-left: 8px;
      vertical-align: middle;
    }
    .venue {
      font-size: 13px;
      color: #666;
      text-align: right;
      min-width: 140px;
      font-weight: 400;
    }
    .tbd { color: #bbb; font-style: italic; }

    /* ── Empty state ─────────────────────────────────────────── */
    .empty { color: #aaa; font-style: italic; margin-top: 32px; }

    /* ── Footer ──────────────────────────────────────────────── */
    .footer {
      margin-top: 48px;
      padding-top: 16px;
      border-top: 1px solid #eee;
      font-size: 11px;
      color: #bbb;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    /* ── Print overrides ─────────────────────────────────────── */
    @media print {
      body { padding: 0; font-size: 13px; max-width: none; }
      h1 { font-size: 24px; }
      .day-header td { padding-top: 20px; }
      .footer {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        padding: 8px 24px;
        background: #fff;
        border-top: 1px solid #ddd;
      }
      @page { margin: 0.75in; }
    }

    /* ── Mobile ──────────────────────────────────────────────── */
    @media (max-width: 560px) {
      body { padding: 28px 20px; font-size: 14px; }
      h1 { font-size: 22px; }
      .venue { display: none; }
      .time { width: 70px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="trip-label">Itinerary</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <span class="date-range">${escapeHtml(dateRange)}</span>
      ${destinationHtml}
    </div>
  </div>

  ${scheduleHtml}

  <div class="footer">
    <span>${escapeHtml(title)}</span>
    <span>Generated ${new Date().toLocaleDateString("en-US", {
      timeZone: DISPLAY_TZ,
      month: "long",
      day: "numeric",
      year: "numeric",
    })}</span>
  </div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // No caching — always fresh from DB.
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

export default router;
