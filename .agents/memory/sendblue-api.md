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
- Dev/sandbox limitation: sending to fake/unverified numbers via `/api/send-message` returns 400 "contact must be verified", and `/api/send-group-message` returns 400 "Invalid group_id specified" for a `group_id` that only exists in our DB (not created through Sendblue). Both are expected in local testing with synthetic phone numbers/group ids, not app bugs — the message is still recorded in our DB even though the outbound send fails, since the send is wrapped in try/catch.
- `POST /api/send-typing-indicator` only works for 1:1 threads — there is no group equivalent, so any typing-indicator feature must no-op (not error) for group threads.
- `POST /api/upload-file` (multipart) uploads media and returns a URL usable as `media_url` on send-message/send-group-message — this is the only documented path to attach generated images (e.g. plan cards) to outbound texts.
- iMessage tapback reactions have no dedicated structured webhook field; they arrive as ordinary inbound `receive` events whose `content` is iMessage's standard textual reaction phrasing (`Loved "…"`, `Liked "…"`, `Disliked "…"`, etc.) — detect them with a regex on `content`, not a payload field.
