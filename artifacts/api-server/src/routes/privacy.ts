import { Router, type IRouter } from "express";

const router: IRouter = Router();

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy — AI Concierge</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.7;
      color: #1a1a1a;
      background: #fafafa;
      padding: 2rem 1rem 4rem;
    }
    .container { max-width: 680px; margin: 0 auto; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    .updated { font-size: 0.85rem; color: #666; margin-bottom: 2rem; }
    h2 { font-size: 1.1rem; font-weight: 600; margin-top: 2rem; margin-bottom: 0.5rem; }
    p { margin-bottom: 1rem; }
    ul { margin: 0.5rem 0 1rem 1.5rem; }
    li { margin-bottom: 0.25rem; }
    code {
      background: #f0f0f0;
      border-radius: 4px;
      padding: 0.1em 0.4em;
      font-size: 0.9em;
    }
    .callout {
      border-left: 3px solid #333;
      background: #f5f5f5;
      padding: 0.75rem 1rem;
      border-radius: 0 6px 6px 0;
      margin: 1rem 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Privacy Policy</h1>
    <p class="updated">AI Concierge &mdash; last updated July 2025</p>

    <p>This AI Concierge is a personal planning assistant delivered via iMessage. This page explains what information the concierge collects, how it uses that information, and how you can control or delete your data.</p>

    <h2>What we collect</h2>
    <p>When you message the concierge or are added to a group it participates in, we may store:</p>
    <ul>
      <li>Your phone number (used to identify you across threads)</li>
      <li>Your preferred name, if you share it during onboarding</li>
      <li>Dietary preferences, budget range, and dining/activity preferences, if you provide them</li>
      <li>The text of messages you send to the concierge</li>
      <li>Metadata about which group threads you participate in</li>
    </ul>

    <h2>How we use it</h2>
    <p>Your profile information is used solely to personalise planning suggestions — restaurant picks, event timing, dietary filters — and is never sold or shared with third parties.</p>
    <p>Message content is used to understand requests and generate replies. It may be sent to an AI provider (OpenAI) for processing. We do not use your messages to train AI models.</p>

    <h2>How long we keep it</h2>
    <p>Your data is retained for as long as you use the concierge. There is no automatic expiry. You can request deletion at any time (see below).</p>

    <h2>Your choices</h2>
    <div class="callout">
      <p><strong>Mute the concierge in a thread:</strong> text <code>mute you</code> in any group thread. The concierge will go quiet in that thread only — it may still introduce itself if you join another group where it's present.</p>
      <p style="margin-bottom:0"><strong>Delete all your data:</strong> text <code>forget me</code> (or <code>delete my data</code>) to the concierge in any thread. This permanently removes your name, preferences, and profile. A final confirmation will be sent, after which no further outreach will occur unless you message first.</p>
    </div>

    <h2>Contact</h2>
    <p>If you have questions about your data or want to request deletion through another channel, reply to any concierge message and ask to be forgotten — a human operator reviews these requests.</p>
  </div>
</body>
</html>`;

/** GET /privacy — static privacy policy page. */
router.get("/privacy", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(PRIVACY_HTML);
});

export default router;
