# Divinci Agent Tool Calling — Implementation Handoff

## Overview

When the on-device Gemma 4 model emits a `divinci:tool-call` event (signaling the user's request needs an external tool), the extension routes the conversation to **Kimi K2.7-Code** (via Cloudflare Workers AI API) which decides which tool to call. The extension executes the tool (currently web search via Brave/Serper), feeds results back to Kimi for synthesis, and replaces the original Gemma 4 output with Kimi's final answer.

This avoids running Gemma 4's tool output (which it can't actually execute) and gives the user a useful answer instead.

## Architecture

```
Popup (credentials entry)
  │  cfAccountId, cfApiToken, braveApiKey, serperApiKey
  ▼
chrome.storage.local[STORAGE_KEY_SETTINGS]
  │
  ▼
Background Service Worker (setupSettingsPersistence / hydrateOffscreenSettings)
  │  internal:set-settings
  ▼
Offscreen Document (userSettings in main.ts)
  │
  ├── Gemma 4 generates response
  ├── Detect divinci:tool-call in output → extract tool calls
  ├── If credentials configured → forward converation to Kimi
  │
  ▼
runKimiLoop()  ──►  cfChatCompletions()  ──►  Cloudflare Workers AI API
      │                                              │
      │  Kimi decides: web_search ?                     │
      │                                              │
      ├── No tool call → return Kimi's text answer ──┘
      │
      └── Tool call → executeWebSearch() (Brave/Serper)
              │
              ▼
        Append results to conversation
        Loop back to Kimi (max 5 iterations)
```

## Files Changed — Complete Inventory

### Shared Types & Protocol

| File | Change |
|---|---|
| `shared/models.ts` | Added `cfAccountId`, `cfApiToken`, `braveApiKey`, `serperApiKey` to `UserSettings`; exported `STORAGE_KEY_SETTINGS` |
| `shared/messages.ts` | Added `args?` to `ChatToolCall`; added `DivinciExternalToolStatusEvent`; added credential fields to `InternalSetSettingsRequest` |
| `shared/tool-definitions.ts` | **New** — `WEB_SEARCH_TOOL` (name, description, input_schema); `REGISTERED_TOOLS` array |

### Tool Call Parser

| File | Change |
|---|---|
| `offscreen/tool-call-parser.ts` | Extended `extractToolCalls()` to also check `args` field alongside `arguments` (Divinci Agent uses `args`; other providers use `arguments`); both populate `ChatToolCall.args` |
| `offscreen/tool-call-parser.test.ts` | +5 tests for Divinci Agent `args` format |

### Cloudflare Workers AI Client

| File | Change |
|---|---|
| `offscreen/cf-api.ts` | **New** — `cfChatCompletions()` (POST to CF Workers AI OpenAI-compatible endpoint); `toCfToolDefinitions()` (converts our `ChatTool[]` to CF format); configurable account ID, API token, model |
| `offscreen/cf-api.test.ts` | 11 tests — request body shape, auth header, error handling, empty choices, model override, default model |

### Web Search

| File | Change |
|---|---|
| `offscreen/web-search.ts` | **New** — `executeWebSearch()` abstracts Brave Search API + Serper.dev API; provider selection (Brave preferred); configurable result count (default 5); returns plain-text formatted results |
| `offscreen/web-search.test.ts` | 8 tests — Brave success/empty/error, Serper success/error, provider selection, count default |

### Kimi Tool Loop

| File | Change |
|---|---|
| `offscreen/kimi-caller.ts` | **New** — `runKimiLoop()` sends conversation + tool definitions to Kimi; executes `web_search` when Kimi requests it; loops tool results back to Kimi; caps at 5 iterations; returns final text answer or fallback message |
| `offscreen/kimi-caller.test.ts` | 7 tests — no-tool path, single tool execution, multiple tools, execution errors, missing parameters, max iterations, conversation history growth |

### Offscreen Doc Integration

| File | Change |
|---|---|
| `entrypoints/offscreen/main.ts` | After Gemma 4 `chat-done`, detects tool calls; if CF credentials present → runs Kimi loop; emits `divinci:tool-status` events for each iteration; replaces Gemma 4 output on success |
| `offscreen/settings-helpers.ts` | `clampSettings()` now forwards credential strings (`cfAccountId`, `cfApiToken`, `braveApiKey`, `serperApiKey`) through to output |

### Settings Pipeline

| File | Change |
|---|---|
| `entrypoints/background.ts` | `setupSettingsPersistence()` writes credential fields to `chrome.storage.local`; `hydrateOffscreenSettings()` sends them to offscreen doc |
| `entrypoints/popup/index.html` | Added "Tool APIs" `<details>` section with 4 credential inputs (CF Account ID, CF API Token, Brave API Key, Serper API Key) |
| `entrypoints/popup/main.ts` | Added element refs for inputs; `sendToolApiCredentials()` commits via `internal:set-settings`; `loadToolApiCredentials()` reads from storage; event listeners per input; called on startup |

## Test Results

```
 Test Files  10 passed (10)
      Tests  124 passed (124)
```

(Originally 9 files / 118 tests; the review added `offscreen/finalize-chat.test.ts`
with 6 tests covering the routing/finalization glue.)

Breakdown by file:

| Test File | Tests |
|---|---|
| `offscreen/settings-helpers.test.ts` | 19 |
| `offscreen/tool-call-parser.test.ts` | 24 |
| `offscreen/cf-api.test.ts` | 11 |
| `offscreen/web-search.test.ts` | 8 |
| `offscreen/kimi-caller.test.ts` | 7 |
| `offscreen/cache-breakdown.test.ts` | 9 |
| `offscreen/chat-host.test.ts` | 12 |
| `background/internal-bridge.test.ts` | 7 |
| `background/external-bridge.test.ts` | 21 |

## State: Reviewed + hardened (branch `fix/tool-calling-handoff-review`)

The credential settings pipeline is wired end-to-end:

```
popup input → chrome.storage → background SW → offscreen doc → userSettings
```

The tool-calling flow runs in `entrypoints/offscreen/main.ts` after Gemma 4's
normal chat completes. A review pass found the original cut did **not** compile
(`wxt build`/`tsc` failed) and shipped three glue-layer bugs the tests didn't
cover. Those are now fixed:

1. **Compile blocker** — `main.ts` referenced `kimiResult.durationMs` (not on the
   return type) with nonsense duration math. `runKimiLoop` now returns
   `durationMs`; final duration = Gemma time + Kimi loop time.
2. **Markup leak** — `stripToolCallEnvelopes()` is now applied on the un-routed
   path (no CF creds, or Kimi errored), so raw `<|tool_call>…<tool_call|>` text
   never reaches the user. Kimi's synthesized answer is passed through clean.
3. **Un-cancellable loop** — an `AbortSignal` is threaded into `runKimiLoop` →
   `cfChatCompletions`; `handleAbort` cancels it, and abort is re-checked before
   the final emit (Stop yields `divinci:aborted`, never a stale answer).
4. **Secret logging** — the offscreen settings log is redacted to presence
   booleans (`hasCfApiToken`, …); no token/key hits the console.
5. **Testability** — the routing/finalization decision is extracted to the pure
   `offscreen/finalize-chat.ts` (`finalizeChatResult`) and covered by
   `offscreen/finalize-chat.test.ts` (6 tests). `pretest` now runs `tsc --noEmit`
   so a type error fails `npm test` (and CI) the way it failed review.
6. **Token-scope guidance** — the popup "Tool APIs" section now warns to scope the
   CF token to *Workers AI → Read/Run* only.
7. **Prompt-injection note** — documented at the tool-result re-entry point in
   `kimi-caller.ts`; bounded today (only `web_search`), must be revisited before
   any side-effecting tool.

`wxt build` (dev + prod) and `tsc --noEmit` both pass; **124** unit tests pass.

## What Remains

1. **Manual E2E verification** — load the unpacked extension, enter real CF
   credentials + a Brave or Serper API key, trigger a query that generates a
   `divinci:tool-call` (e.g., "what's the weather in Tokyo"), verify the Kimi
   loop runs and produces an answer.
2. **Follow-ups (non-blocking):** clamp `count` to `[1,10]` in the web-search
   executor (schema advertises max 10 but it's unenforced); replace bare
   `response.json()` in `cf-api.ts` / `web-search.ts` with text+parse for clearer
   non-JSON error messages; surface Kimi's *executed* tool calls in the
   tool-status events rather than Gemma's trigger calls.

## Key Design Decisions

- **Two-phase routing**: Gemma 4 generates first; if tool calls detected, Kimi handles execution. Gemma 4 never executes tools directly.
- **`args` vs `arguments`**: Divinci Agent uses `args`, other providers use `arguments`. The parser populates `ChatToolCall.args` from whichever field is present.
- **Plain-text search results**: Web search results are formatted as readable text (not JSON) so the model can consume them naturally.
- **Brave preferred**: When both Brave and Serper keys are configured, Brave is used. Falls back to Serper if only Serper is configured.
- **No debounce on credentials**: Credential inputs commit immediately per keystroke (same pattern as RAG config), since credentials must reach the offscreen doc before a tool-calling query arrives.
- **Settings through `clampSettings()`**: Credential strings pass through the same settings pipeline as numeric settings, keeping the architecture uniform.

## Cloudflare Workers AI Details

- **Model**: `@cf/moonshotai/kimi-k2.7-code` (Moonshot AI's Kimi K2.7-Code)
- **Endpoint**: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions` (OpenAI-compatible)
- **Auth**: `Authorization: Bearer {CF_API_TOKEN}` header
- **Tool format**: OpenAI-compatible `tools` array (CF Workers AI supports tool calling)
