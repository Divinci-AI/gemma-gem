/**
 * tool-call-parser tests.
 *
 * Pins the Gemma 4 envelope format documented in the model's
 * tokenizer_config.json (`x-parser: gemma4-tool-call`,
 * `x-regex-iterator: <\|tool_call>(.*?)<tool_call\|>`) and the
 * Hermes-style JSON fallback. Without web-app round-trip yet, this
 * is the only thing standing between "we wired it" and "we shipped
 * a regression nobody notices until WebMCP lands."
 */

import { describe, it, expect } from 'vitest'
import { parseToolCalls, stripToolCallEnvelopes } from './tool-call-parser'
import type { ChatTool } from '@/shared/messages'

const SAMPLE_TOOL: ChatTool = {
  name: 'get_weather',
  description: 'Look up current weather',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
  },
}

describe('parseToolCalls — quick exit', () => {
  it('returns [] when no envelope tokens are present (zero-cost plain chat)', () => {
    expect(parseToolCalls('hello world', [SAMPLE_TOOL], 'req-1')).toEqual([])
  })

  it('returns [] when fullText is empty', () => {
    expect(parseToolCalls('', [SAMPLE_TOOL], 'req-1')).toEqual([])
  })

  it('returns [] when text contains envelope-like substring but no full match', () => {
    // Just the prefix without the closer — model bailed out mid-call.
    expect(parseToolCalls('<|tool_call> partial', [SAMPLE_TOOL], 'req-1')).toEqual([])
  })
})

describe('parseToolCalls — Gemma 4 native format', () => {
  it('extracts a single tool call with string args (with <|"|> escapes)', () => {
    const text =
      'Sure, looking that up.\n<|tool_call>call:get_weather{location:<|"|>San Francisco<|"|>,units:<|"|>celsius<|"|>}<tool_call|>'
    const calls = parseToolCalls(text, [SAMPLE_TOOL], 'req-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      id: 'req-1-0',
      name: 'get_weather',
      arguments: { location: 'San Francisco', units: 'celsius' },
    })
  })

  it('extracts multiple sequential tool calls with stable id ordering', () => {
    const text =
      '<|tool_call>call:tool_a{x:<|"|>one<|"|>}<tool_call|>' +
      'middle text\n' +
      '<|tool_call>call:tool_b{y:<|"|>two<|"|>}<tool_call|>'
    const calls = parseToolCalls(text, undefined, 'req-2')
    expect(calls).toEqual([
      { id: 'req-2-0', name: 'tool_a', arguments: { x: 'one' } },
      { id: 'req-2-1', name: 'tool_b', arguments: { y: 'two' } },
    ])
  })

  it('handles numeric and boolean args (already JSON-shaped)', () => {
    const text = '<|tool_call>call:set_temp{degrees:72,enabled:true}<tool_call|>'
    const calls = parseToolCalls(text, undefined, 'req-3')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ degrees: 72, enabled: true })
  })

  it('preserves raw arg text when the body cannot be parsed as JSON', () => {
    // Truly malformed: dangling `:` with no value. Both passes fail.
    const text = '<|tool_call>call:weird_tool{key:}<tool_call|>'
    const calls = parseToolCalls(text, undefined, 'req-4')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('weird_tool')
    expect(calls[0].arguments).toEqual({ _rawArgs: 'key:' })
  })

  it('handles empty arg body (zero-arg tool call)', () => {
    const text = '<|tool_call>call:noop{}<tool_call|>'
    const calls = parseToolCalls(text, undefined, 'req-5')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ id: 'req-5-0', name: 'noop', arguments: {} })
  })

  it('does NOT filter against declared tool names (surfaces hallucinated calls)', () => {
    const text = '<|tool_call>call:made_up_tool{x:<|"|>y<|"|>}<tool_call|>'
    const calls = parseToolCalls(text, [SAMPLE_TOOL], 'req-6')
    // Surfacing it is the right behaviour — caller decides whether to
    // execute, ignore, or refuse the hallucinated call. Filtering at
    // this layer would silently drop signal the web app needs.
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('made_up_tool')
  })

  it('strips leading/trailing whitespace around the call envelope contents', () => {
    const text = '<|tool_call>\n  call:get_weather{location:<|"|>NYC<|"|>}  \n<tool_call|>'
    const calls = parseToolCalls(text, undefined, 'req-7')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('get_weather')
    expect(calls[0].arguments).toEqual({ location: 'NYC' })
  })
})

describe('parseToolCalls — Hermes / OpenAI JSON fallback', () => {
  it('extracts a JSON-shape call inside <tool_call>...</tool_call>', () => {
    const text =
      '<tool_call>{"name":"get_weather","arguments":{"location":"Boston"}}</tool_call>'
    const calls = parseToolCalls(text, undefined, 'req-h1')
    expect(calls).toEqual([
      { id: 'req-h1-0', name: 'get_weather', arguments: { location: 'Boston' } },
    ])
  })

  it('handles stringified arguments (OpenAI Chat Completions shape)', () => {
    const text =
      '<tool_call>{"name":"get_weather","arguments":"{\\"location\\":\\"Boston\\"}"}</tool_call>'
    const calls = parseToolCalls(text, undefined, 'req-h2')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ location: 'Boston' })
  })

  it('returns _rawArgs when stringified arguments are not valid JSON', () => {
    const text =
      '<tool_call>{"name":"weird","arguments":"not-json-here"}</tool_call>'
    const calls = parseToolCalls(text, undefined, 'req-h3')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ _rawArgs: 'not-json-here' })
  })

  it('skips calls missing a name field', () => {
    const text =
      '<tool_call>{"arguments":{"x":1}}</tool_call>' +
      '<tool_call>{"name":"ok","arguments":{"x":2}}</tool_call>'
    const calls = parseToolCalls(text, undefined, 'req-h4')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('ok')
  })

  it('does NOT run Hermes pass when Gemma envelopes were already found', () => {
    // Mixed text: Gemma envelope + a stray Hermes-shaped block. Should
    // only return the Gemma match (the Hermes pass is a fallback).
    const text =
      '<|tool_call>call:gemma_call{x:<|"|>g<|"|>}<tool_call|>' +
      '<tool_call>{"name":"hermes_call","arguments":{}}</tool_call>'
    const calls = parseToolCalls(text, undefined, 'req-mix')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('gemma_call')
  })
})

describe('stripToolCallEnvelopes', () => {
  it('removes Gemma 4 envelopes and trims', () => {
    const text =
      'Sure, looking that up.\n<|tool_call>call:get_weather{location:<|"|>NYC<|"|>}<tool_call|>'
    expect(stripToolCallEnvelopes(text)).toBe('Sure, looking that up.')
  })

  it('removes Hermes envelopes', () => {
    const text =
      'Calling tool: <tool_call>{"name":"x","arguments":{}}</tool_call> done.'
    expect(stripToolCallEnvelopes(text)).toBe('Calling tool:  done.')
  })

  it('removes both formats in mixed output', () => {
    const text =
      'a <|tool_call>call:t1{}<tool_call|> b <tool_call>{"name":"t2"}</tool_call> c'
    expect(stripToolCallEnvelopes(text)).toBe('a  b  c')
  })

  it('no-op on plain text (no envelopes)', () => {
    expect(stripToolCallEnvelopes('hello world')).toBe('hello world')
  })
})
