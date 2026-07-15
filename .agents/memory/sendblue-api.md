---
name: Sendblue API basics
description: Auth headers, key endpoints, and webhook event shape for building an iMessage bot on Sendblue.
---

- Auth: header-based, `sb-api-key-id` and `sb-api-secret-key` (not bearer tokens, not query params).
- Base URL: `https://api.sendblue.com`.
- Send 1:1: `POST /api/send-message` with `{ content, from_number, number }` (`from_number` must be a Sendblue-registered number in E.164; `media_url` optional).
- Send group: `POST /api/send-group-message` with `{ content, group_id, from_number }`.
- Webhooks: configurable per event type (`receive`, `outbound`, `typing_indicator`, `call_log`, `line_blocked`, `line_assigned`, `contact_created`). Inbound message events arrive as POSTs to a URL you register in the Sendblue dashboard/API — there is no fixed callback path.
- Full webhook payload/signature verification details weren't confirmed from docs (page truncated in fetches); if signature verification is needed, re-check `https://docs.sendblue.com/getting-started/webhooks/` for the "Webhook Security" section before trusting `is_outbound`/`group_id` fields blindly in production.
- Groups: Sendblue's group identifier (`group_id`) is the only stable handle for a group thread — there's no other way to key a group conversation.
