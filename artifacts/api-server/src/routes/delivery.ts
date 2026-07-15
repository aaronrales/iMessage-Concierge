import { Router, type IRouter } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import { db, messageDeliveryLogTable } from "@workspace/db";

/**
 * Delivery log endpoints consumed by the ops dashboard.
 *
 * GET /delivery-log          — recent ERROR and BLOCKED rows (operator feed).
 * GET /delivery-log/blocked  — phone numbers that have issued a line_blocked event.
 */
const router: IRouter = Router();

/** Returns the 100 most recent delivery failures and block events. */
router.get("/delivery-log", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(messageDeliveryLogTable)
    .where(inArray(messageDeliveryLogTable.status, ["ERROR", "FAILED", "BLOCKED"]))
    .orderBy(desc(messageDeliveryLogTable.createdAt))
    .limit(100);

  res.json({ items: rows });
});

/** Returns the distinct phone numbers that have triggered a line_blocked event. */
router.get("/delivery-log/blocked", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: messageDeliveryLogTable.id,
      recipientPhone: messageDeliveryLogTable.recipientPhone,
      createdAt: messageDeliveryLogTable.createdAt,
    })
    .from(messageDeliveryLogTable)
    .where(eq(messageDeliveryLogTable.status, "BLOCKED"))
    .orderBy(desc(messageDeliveryLogTable.createdAt));

  // De-duplicate by phone; keep most-recent block event per number.
  const seen = new Set<string>();
  const distinct = rows.filter((r) => {
    if (!r.recipientPhone || seen.has(r.recipientPhone)) return false;
    seen.add(r.recipientPhone);
    return true;
  });

  res.json({ items: distinct });
});

export default router;
