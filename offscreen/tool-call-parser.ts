/**
 * Best-effort parser for tool-call output from Gemma 4 (and JSON-style
 * fallbacks for when a future model is wired in).
 *
 * Gemma 4 emits tool calls in its native non-JSON format:
 *
 *   <|tool_call>call:NAME{key:value,...}<tool_call|>
 *
 * with strings escaped as `<|"|>...<|"|>` and nested mappings/arrays
 * using `{}` / `[]`. This is documented in the model's
 * tokenizer_config.json (`x-parser: gemma4-tool-call`,
 * `x-regex-iterator: <\|tool_call>(.*?)<tool_call\|>`).
 *
 * Some models (Hermes, OpenAI-style) emit JSON instead. We try the
 * Gemma envelope first, then fall through to a permissive JSON
 * extractor so the same parser works against either.
 *
 * Speculative scope: web app does not yet round-trip tool-call output
 * (see project_browser_llm_emerging_standards.md). We surface what the
 * model said best-effort; the web app can validate + iterate from there.
 */

import type { ChatTool, ChatToolCall } from '@/shared/messages'

const GEMMA_TOOL_CALL_RE = /<\|tool_call>([\s\S]*?)<tool_call\|>/g
const GEMMA_CALL_HEADER_RE = /^call:([^{]+)\{([\s\S]*)\}$/
// Hermes-style: <tool_call>{"name":..., "arguments":{...}}</tool_call>
const HERMES_TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g

/**
 * Replace Gemma's `<|"|>...<|"|>` string-escape sequence with regular
 * JSON double quotes. Idempotent — re-running on the result is a no-op.
 */
function unescapeGemmaStrings(s: string): string {
  return s.replace(/<\|"\|>/g, '"')
}

/**
 * Best-effort JSON.parse of a Gemma argument body. Returns the parsed
 * object on success, or `{ _rawArgs: <input> }` so callers always see
 * SOMETHING — losing the raw string would be worse than partial structure.
 *
 * The Gemma format has subtleties JSON doesn't grok (unquoted keys, no
 * comma-after-last-element, etc.). We try a series of progressively more
 * forgiving transforms before giving up.
 */
function parseGemmaArguments(rawBody: string): Record<string, unknown> {
  const trimmed = rawBody.trim()
  if (trimmed.length === 0) return {}

  const candidate = `{${unescapeGemmaStrings(trimmed)}}`

  // Attempt 1: as-is (works when args are already well-formed JSON-ish).
  try {
    const parsed = JSON.parse(candidate)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }

  // Attempt 2: quote bare keys. Matches `key:` at start or after `,`/`{`
  // and wraps the key in quotes. Conservative: only matches identifier
  // characters, won't touch already-quoted keys.
  const withQuotedKeys = candidate.replace(
    /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g,
    '$1"$2":',
  )
  try {
    const parsed = JSON.parse(withQuotedKeys)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }

  return { _rawArgs: rawBody }
}

/**
 * Parse Hermes/OpenAI-style JSON tool calls.
 * Shape: `{ "name": "...", "arguments": {...} }` (object) OR
 *        `{ "name": "...", "arguments": "{...}" }` (stringified args)
 *
 * Also handles the Divinci Agent variant which uses `args` instead of `arguments`:
 *        `{ "name": "...", "args": {...} }`
 * When `arguments` is absent, falls back to `args` and normalizes it.
 */
function parseHermesToolCall(json: string): { name: string; arguments: Record<string, unknown> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.name !== 'string') return null

  let args: Record<string, unknown>

  // Try `arguments` first (OpenAI / Hermes standard)
  if ('arguments' in obj) {
    if (typeof obj.arguments === 'string') {
      try {
        const argsParsed = JSON.parse(obj.arguments)
        args =
          argsParsed && typeof argsParsed === 'object' && !Array.isArray(argsParsed)
            ? (argsParsed as Record<string, unknown>)
            : { _rawArgs: obj.arguments }
      } catch {
        args = { _rawArgs: obj.arguments }
      }
    } else if (
      obj.arguments &&
      typeof obj.arguments === 'object' &&
      !Array.isArray(obj.arguments)
    ) {
      args = obj.arguments as Record<string, unknown>
    } else {
      args = {}
    }
  } else if ('args' in obj) {
    // Divinci Agent variant: `args` instead of `arguments`
    if (typeof obj.args === 'string') {
      try {
        const argsParsed = JSON.parse(obj.args)
        args =
          argsParsed && typeof argsParsed === 'object' && !Array.isArray(argsParsed)
            ? (argsParsed as Record<string, unknown>)
            : { _rawArgs: obj.args }
      } catch {
        args = { _rawArgs: obj.args }
      }
    } else if (
      obj.args &&
      typeof obj.args === 'object' &&
      !Array.isArray(obj.args)
    ) {
      args = obj.args as Record<string, unknown>
    } else {
      args = {}
    }
  } else {
    args = {}
  }

  return { name: obj.name, arguments: args }
}

/**
 * Extract any tool calls from the model's full-text output.
 *
 * Returns an empty array when no tools were declared OR when no tool-call
 * envelopes are present — callers should check the length before treating
 * the response as a tool-use round.
 *
 * @param fullText  The model's full output text (post-streaming).
 * @param tools     The tool descriptors that were sent in the request.
 *                  Used only as a hint: callers that pass undefined still
 *                  get parsed calls back if any envelopes are present.
 *                  Mismatched names are NOT filtered — we surface what
 *                  the model said, even if it hallucinated a tool, so
 *                  the web app can decide how to handle it.
 * @param idPrefix  Stable prefix for synthesised tool-call ids
 *                  (e.g., the request id). Each call gets `${prefix}-${i}`.
 */
export function parseToolCalls(
  fullText: string,
  tools: ChatTool[] | undefined,
  idPrefix: string,
): ChatToolCall[] {
  // Quick exit when neither tools nor envelopes are present. This keeps
  // the hot path (plain chat) zero-cost.
  if (!fullText.includes('<|tool_call>') && !fullText.includes('<tool_call>')) {
    return []
  }

  const calls: ChatToolCall[] = []
  let index = 0

  // Gemma 4 native format.
  for (const match of fullText.matchAll(GEMMA_TOOL_CALL_RE)) {
    const inner = match[1].trim()
    const headerMatch = inner.match(GEMMA_CALL_HEADER_RE)
    if (!headerMatch) continue
    const name = headerMatch[1].trim()
    const argsBody = headerMatch[2]
    calls.push({
      id: `${idPrefix}-${index}`,
      name,
      arguments: parseGemmaArguments(argsBody),
    })
    index += 1
  }

  // Hermes / OpenAI-style JSON-tagged format. We only run this fallback
  // if the Gemma matcher didn't find anything — the two formats use
  // distinct envelopes (<|tool_call>...<tool_call|> vs <tool_call>...</tool_call>),
  // so they're not ambiguous, but skipping the second pass when the
  // first found something keeps the loop cheap.
  if (calls.length === 0) {
    for (const match of fullText.matchAll(HERMES_TOOL_CALL_RE)) {
      const parsed = parseHermesToolCall(match[1].trim())
      if (!parsed) continue
      calls.push({
        id: `${idPrefix}-${index}`,
        name: parsed.name,
        arguments: parsed.arguments,
        // Normalize: Divinci Agent format uses `args`, OpenAI/Hermes use `arguments`.
        // Setting both so consumers can read whichever field their downstream expects.
        args: parsed.arguments,
      })
      index += 1
    }
  }

  // Reference `tools` so unused-param lint stays happy + give future code
  // a hook to filter/validate against declared tool names if we want to.
  void tools

  return calls
}

/**
 * Strip tool-call envelopes from the displayed text so the user-facing
 * response doesn't include `<|tool_call>...<tool_call|>` markup. Callers
 * that want the raw envelope (e.g., to round-trip back to the model) can
 * skip this and use fullText directly.
 */
export function stripToolCallEnvelopes(fullText: string): string {
  return fullText
    .replace(GEMMA_TOOL_CALL_RE, '')
    .replace(HERMES_TOOL_CALL_RE, '')
    .trim()
}
