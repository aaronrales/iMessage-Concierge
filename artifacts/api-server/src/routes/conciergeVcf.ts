import { Router, type IRouter } from "express";

/**
 * Serves a vCard for the concierge so recipients can save it as a contact.
 * Sent as a `mediaUrl` on every user's first-ever outbound DM.
 *
 * The phone number is read from `SENDBLUE_FROM_NUMBER`; without it the
 * vCard omits the phone line rather than failing (the card is still useful
 * as a named contact that triggers iMessage's "known sender" label).
 */

const router: IRouter = Router();

router.get("/concierge.vcf", (_req, res): void => {
  const phone = process.env["SENDBLUE_FROM_NUMBER"] ?? "";

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Concierge",
    "N:Concierge;;;",
    ...(phone ? [`TEL;TYPE=CELL:${phone}`] : []),
    "END:VCARD",
  ];

  res.setHeader("Content-Type", "text/vcard; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="concierge.vcf"');
  res.send(lines.join("\r\n") + "\r\n");
});

export default router;
