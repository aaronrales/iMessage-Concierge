import { Router } from "express";
import { getPlanById } from "../lib/agent/plans";
import { buildIcsString } from "../lib/agent/calendar";

const router = Router();

/**
 * Serves a valid `.ics` calendar file for a confirmed plan. Linked from the
 * booking confirmation text message so iPhone users can tap "Add to Calendar"
 * natively without a Google account.
 *
 * Requires `PUBLIC_API_URL` env var to be set to the full base URL of this
 * server (e.g. `https://abc.replit.app/api-server`) for the URL to be
 * constructable; the endpoint always works once hit directly.
 */
router.get("/:id/calendar.ics", async (req, res) => {
  const id = Number.parseInt(req.params.id ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid plan id" });
    return;
  }

  const plan = await getPlanById(id);
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const ics = buildIcsString(plan);
  if (!ics) {
    res.status(422).json({ error: "Plan has no scheduled time" });
    return;
  }

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="plan-${plan.id}.ics"`);
  res.status(200).send(ics);
});

export default router;
