import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendDirectMessage } from "../sendblue";
import { logger } from "../logger";

/**
 * Sends contact card to a user on their very first outbound DM. This lets
 * them save the number as "Concierge" so future messages feel personal.
 * Marks-before-send so a crash fails toward under-sending, not double-sending.
 */
export async function sendContactCardIfNeeded(userId: number, phone: string): Promise<void> {
  const [user] = await db.select({ contactCardSent: usersTable.contactCardSent }).from(usersTable).where(eq(usersTable.id, userId));
  if (!user || user.contactCardSent) return;

  const base =
    process.env["PUBLIC_API_URL"] ??
    (process.env["REPLIT_DEV_DOMAIN"] ? `https://${process.env["REPLIT_DEV_DOMAIN"]}/api-server` : null);

  if (!base) return; // no public URL configured; skip silently

  const vcfUrl = `${base.replace(/\/$/, "")}/concierge.vcf`;

  await db.update(usersTable).set({ contactCardSent: true }).where(eq(usersTable.id, userId));
  try {
    await sendDirectMessage({ to: phone, content: "", mediaUrl: vcfUrl });
  } catch (error) {
    logger.warn({ error, userId }, "Failed to send contact card; resetting flag");
    await db.update(usersTable).set({ contactCardSent: false }).where(eq(usersTable.id, userId));
  }
}
