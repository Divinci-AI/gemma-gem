# chat-core (§0 foundation)

Surface-agnostic chat engine extracted from the sidebar/popup so every surface —
sidebar, popup, the planned page-wide chat, and the desktop app — is a thin shell
over the same engine. No DOM, no `chrome.*` in the contracts.

## Modules
- `inference.ts` — `InferenceClient` (the chat backend seam): `LocalInference`
  (offscreen Gemma) and `AccountInference` (Divinci account proxy).
- `transcript-store.ts` — `TranscriptStore` (conversation persistence):
  `LocalTranscriptStore` (IndexedDB) and `AccountTranscriptStore` (account).
- `ChatController` (next) — holds a transcript, calls an `InferenceClient`,
  persists via a `TranscriptStore`, emits events. The thing the surfaces render.

## Dogfood the Divinci SDK (`@divinci-ai/server`)
Verified in the SDK source (v0.1.10):
- The client **already accepts `accessToken`** (→ `Authorization: Bearer`) as well
  as `apiKey` (→ `X-API-Key`). So the extension's OAuth token plugs straight in:
  `new DivinciServer({ accessToken, baseUrl: 'https://api.stage.divinci.app' })`.
- `transcripts` client already has `list / get / create / delete / addMessage /
  ingestBatch` — exactly what the page-wide chat persistence + import need.

→ `AccountInference` and `AccountTranscriptStore` should be built on the SDK,
replacing the hand-rolled fetch in `shared/divinci-account.ts` and
`shared/divinci-api.ts`.

## SDK gaps to fill along the way (server monorepo: `workspace/sdk` + `public-api`)
1. **No chat-completions method.** The SDK can't call the chat endpoint.
   → add `divinci.workspaces(id).chat.completions({ messages, releaseId })`
   mapping to `POST /api/v1/workspaces/:id/chat/completions` (the OAuth tool
   proxy we shipped). Until then `AccountInference` may call that endpoint
   directly and swap to the SDK method once published.
2. **Transcript routes are API-key-only mounted.** OAuth (logged-in user)
   callers can't reach `/api/v1/transcripts/*`. The page-wide chat is an OAuth
   user, so `AccountTranscriptStore` needs **OAuth-accessible, workspace-scoped,
   owner-guarded** transcript routes — mirror the `chat-oauth.ts` pattern
   (`/api/v1/workspaces/:id/transcripts/*`). Then point the SDK transcripts
   client at the workspace-scoped paths when constructed with `accessToken`.
3. **Consume strategy.** The extension uses the *published* SDK. Filling gaps
   = edit SDK source → publish → bump the extension dep. For local iteration,
   consume via `pnpm pack` tarball or a `file:` dep until published.

Gaps that don't fit the SDK cleanly stay custom (e.g. the offscreen
`LocalInference` is inherently extension-specific).

## Extraction order (incremental, keep green at each step)
1. Land these contracts (done).
2. `LocalInference` — wrap the existing offscreen port; route the sidebar's
   send through it (no behavior change).
3. `AccountInference` — SDK-backed (fill gap #1 first); fold in the current
   account-mode branch from `finalize-chat.ts`.
4. `ChatController` — move the sidebar's send/stream/history logic in; sidebar
   becomes a renderer. Popup chat (if any) follows.
5. `LocalTranscriptStore` (IndexedDB) + `AccountTranscriptStore` (SDK, after
   gap #2) → unblocks §1 page-wide chat.
