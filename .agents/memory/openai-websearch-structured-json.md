---
name: OpenAI web_search + structured JSON via AI Integrations proxy
description: Confirms `tools:[{type:"web_search"}]` and strict json_schema output work together in one Responses API call through the proxy, and how to work around stale SDK types for it.
---

Confirmed empirically: `openai.responses.create({ model, tools: [{ type: "web_search" }], text: { format: { type: "json_schema", ... , strict: true } } })` works as a single call through the Replit AI Integrations OpenAI proxy — the model performs real web searches and still returns schema-conformant structured JSON. This was the biggest open risk before building an LLM web-search extraction pipeline; it does not require two separate calls (one for search, one for structuring).

**Why this needed confirming:** it's easy to assume web-search tools and strict structured-output modes are mutually exclusive (common in other providers/older API shapes), which would force a much more expensive two-call pattern (search then re-prompt to structure).

**How to apply:** when building any pipeline that needs both live web lookups and reliable structured extraction, use this one-call pattern via the proxy rather than splitting into a search call + a structuring call.

**Gotcha:** the installed `openai` npm package's TypeScript types may only declare `"web_search_preview"` in the `tools[].type` union (types lag what the proxy actually accepts/executes). If you see a TS overload error for `type: "web_search"` despite it working at runtime, cast the tools array (e.g. `as unknown as OpenAI.Responses.Tool[]`) rather than downgrading to the preview tool name.
