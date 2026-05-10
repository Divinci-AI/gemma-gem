/**
 * External-bridge tests.
 *
 * Locks down the boundary between web-app callers and the offscreen doc:
 *  - Origin allowlist enforcement (the security boundary).
 *  - Per-port caller-id assignment + isolation.
 *  - InternalEvent envelope routing (offscreen → background → matching port).
 *  - Disconnect cleanup (caller removed; abort forwarded).
 *  - One-shot ping endpoint (capability probe path).
 *
 * No transformers.js, no WebGPU. We mock the chrome.runtime surface and
 * the offscreen-manager dependency so the bridge's own logic is the only
 * thing under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Mock offscreen-manager BEFORE importing external-bridge ----
// ensureOffscreenDocument is awaited inside handleExternalRequest for
// load + chat; we don't want it to actually try to spawn an offscreen
// document during tests. A no-op resolve is enough.
//
// Use vi.hoisted so the mock function exists at the moment the hoisted
// vi.mock factory runs (vi.mock is hoisted to the top of the file
// before any module-level `const` declarations).
const { ensureOffscreenDocumentMock } = vi.hoisted(() => ({
  ensureOffscreenDocumentMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./offscreen-manager', () => ({
  ensureOffscreenDocument: ensureOffscreenDocumentMock,
}))

// ---- Logger noise control ----
vi.mock('@/shared/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// ---- chrome.runtime fake (must exist before external-bridge imports it) ----
type Listener<T = unknown> = (...args: T[]) => unknown
interface ListenerHook<T = unknown> {
  addListener: (fn: Listener<T>) => void
  removeListener: (fn: Listener<T>) => void
  getListeners: () => Array<Listener<T>>
}
function makeHook<T = unknown>(): ListenerHook<T> {
  const listeners: Array<Listener<T>> = []
  return {
    addListener: (fn) => {
      listeners.push(fn)
    },
    removeListener: (fn) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    getListeners: () => listeners.slice(),
  }
}

const onMessageExternalHook = makeHook<unknown>()
const onConnectExternalHook = makeHook<chrome.runtime.Port>()
const onMessageHook = makeHook<unknown>()
const sendMessageMock = vi.fn().mockResolvedValue(undefined)
const getManifestMock = vi.fn().mockReturnValue({ version: '0.1.2-test' })

;(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onMessageExternal: onMessageExternalHook,
    onConnectExternal: onConnectExternalHook,
    onMessage: onMessageHook,
    sendMessage: sendMessageMock,
    getManifest: getManifestMock,
  },
}

// ---- Now import the system under test ----
import { setupExternalBridge } from './external-bridge'
import type {
  DivinciExternalEvent,
  DivinciExternalRequest,
  InternalEvent,
} from '@/shared/messages'

// ---- Fake port ----
interface FakePort {
  name: string
  sender?: { origin?: string }
  postMessages: DivinciExternalEvent[]
  messageListeners: Array<(msg: DivinciExternalRequest) => void>
  disconnectListeners: Array<() => void>
  onMessage: { addListener: (fn: (msg: DivinciExternalRequest) => void) => void }
  onDisconnect: { addListener: (fn: () => void) => void }
  postMessage: (msg: DivinciExternalEvent) => void
  disconnect: ReturnType<typeof vi.fn>
  /** Test helpers */
  receive: (msg: DivinciExternalRequest) => void
  triggerDisconnect: () => void
}

function makePort(origin: string | undefined, name = 'divinci-port'): FakePort {
  const port: FakePort = {
    name,
    sender: origin === undefined ? undefined : { origin },
    postMessages: [],
    messageListeners: [],
    disconnectListeners: [],
    onMessage: {
      addListener(fn) {
        port.messageListeners.push(fn)
      },
    },
    onDisconnect: {
      addListener(fn) {
        port.disconnectListeners.push(fn)
      },
    },
    postMessage(msg) {
      port.postMessages.push(msg)
    },
    disconnect: vi.fn(),
    receive(msg) {
      for (const fn of port.messageListeners) fn(msg)
    },
    triggerDisconnect() {
      for (const fn of port.disconnectListeners) fn()
    },
  }
  return port
}

function emitConnect(port: FakePort): void {
  for (const fn of onConnectExternalHook.getListeners()) {
    fn(port as unknown as chrome.runtime.Port)
  }
}

function emitInternalEvent(envelope: InternalEvent): void {
  for (const fn of onMessageHook.getListeners()) {
    fn(envelope)
  }
}

function callOnMessageExternal(
  msg: unknown,
  origin: string | undefined,
): { responded: unknown; returnValue: unknown } {
  let responded: unknown = '__no_response__'
  const sendResponse = (r: unknown): void => {
    responded = r
  }
  const sender = origin === undefined ? {} : { origin }
  let returnValue: unknown
  for (const fn of onMessageExternalHook.getListeners()) {
    returnValue = (
      fn as (m: unknown, s: unknown, r: (v: unknown) => void) => unknown
    )(msg, sender, sendResponse)
  }
  return { responded, returnValue }
}

beforeEach(() => {
  // Reset listener arrays + mocks between tests so each test starts with
  // a fresh setupExternalBridge call.
  onMessageExternalHook.getListeners().forEach((fn) =>
    onMessageExternalHook.removeListener(fn as Listener<unknown>),
  )
  onConnectExternalHook.getListeners().forEach((fn) =>
    onConnectExternalHook.removeListener(fn as Listener<chrome.runtime.Port>),
  )
  onMessageHook.getListeners().forEach((fn) =>
    onMessageHook.removeListener(fn as Listener<unknown>),
  )
  sendMessageMock.mockClear()
  ensureOffscreenDocumentMock.mockClear()
  setupExternalBridge()
})

describe('external-bridge: origin allowlist (security boundary)', () => {
  it.each([
    'https://chat.divinci.app',
    'https://chat.stage.divinci.app',
    'https://chat.dev.divinci.app',
  ])('accepts allowed origin %s', (origin) => {
    const port = makePort(origin)
    emitConnect(port)
    expect(port.disconnect).not.toHaveBeenCalled()
    expect(port.messageListeners.length).toBe(1)
  })

  it.each([
    'https://evil.example.com',
    'https://chat.divinci.app.attacker.com',
    'http://chat.divinci.app', // wrong scheme
    'https://CHAT.divinci.app', // case mismatch (ALLOWED list is exact-match)
    '', // empty string
  ])('rejects disallowed origin %s', (origin) => {
    const port = makePort(origin)
    emitConnect(port)
    expect(port.disconnect).toHaveBeenCalledOnce()
    expect(port.messageListeners.length).toBe(0)
  })

  it('rejects port with no sender.origin at all', () => {
    const port = makePort(undefined)
    emitConnect(port)
    expect(port.disconnect).toHaveBeenCalledOnce()
  })

  it('one-shot ping ignores disallowed origins (no pong written)', () => {
    const { responded, returnValue } = callOnMessageExternal(
      { type: 'divinci:ping' },
      'https://evil.example.com',
    )
    expect(responded).toBe('__no_response__')
    expect(returnValue).toBeUndefined()
  })

  it('one-shot ping responds with pong + version + supported models for allowed origin', () => {
    const { responded, returnValue } = callOnMessageExternal(
      { type: 'divinci:ping' },
      'https://chat.divinci.app',
    )
    expect(returnValue).toBe(true) // signals async response intent
    expect(responded).toMatchObject({
      type: 'divinci:pong',
      extensionVersion: '0.1.2-test',
    })
    const supported = (responded as { supportedModels: unknown[] }).supportedModels
    expect(Array.isArray(supported)).toBe(true)
    expect(supported).toContain('gemma-4-e2b')
  })
})

describe('external-bridge: request routing', () => {
  it('divinci:ping over a port responds via postMessage (not sendResponse)', async () => {
    const port = makePort('https://chat.divinci.app')
    emitConnect(port)
    port.receive({ type: 'divinci:ping' })
    // handleExternalRequest's ping branch is sync; allow microtask flush.
    await Promise.resolve()
    expect(port.postMessages.length).toBe(1)
    expect(port.postMessages[0]).toMatchObject({
      type: 'divinci:pong',
      extensionVersion: '0.1.2-test',
    })
  })

  it('divinci:load forwards an internal:load to the offscreen', async () => {
    const port = makePort('https://chat.divinci.app')
    emitConnect(port)
    port.receive({
      type: 'divinci:load',
      requestId: 'req-1',
      modelId: 'gemma-4-e2b',
    })
    // handleExternalRequest awaits ensureOffscreenDocument; flush.
    await Promise.resolve()
    await Promise.resolve()
    expect(ensureOffscreenDocumentMock).toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledOnce()
    const sent = sendMessageMock.mock.calls[0][0]
    expect(sent).toMatchObject({
      type: 'internal:load',
      requestId: 'req-1',
      modelId: 'gemma-4-e2b',
    })
    expect(typeof (sent as { caller: string }).caller).toBe('string')
  })

  it('divinci:chat forwards messages + sampling params + tools field', async () => {
    const port = makePort('https://chat.divinci.app')
    emitConnect(port)
    port.receive({
      type: 'divinci:chat',
      requestId: 'req-2',
      modelId: 'gemma-4-e2b',
      messages: [{ role: 'user', content: 'hi' }],
      maxNewTokens: 16,
      temperature: 0.7,
      topP: 0.9,
      tools: [{ name: 'echo', description: 'echo back' }],
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(sendMessageMock).toHaveBeenCalledOnce()
    expect(sendMessageMock.mock.calls[0][0]).toMatchObject({
      type: 'internal:chat',
      requestId: 'req-2',
      modelId: 'gemma-4-e2b',
      messages: [{ role: 'user', content: 'hi' }],
      maxNewTokens: 16,
      temperature: 0.7,
      topP: 0.9,
      tools: [{ name: 'echo', description: 'echo back' }],
    })
  })

  it('divinci:abort forwards an internal:abort with the same caller id', async () => {
    const port = makePort('https://chat.divinci.app')
    emitConnect(port)
    // Trigger any request first so we know the assigned caller id is the
    // same one used for the abort.
    port.receive({
      type: 'divinci:load',
      requestId: 'req-3',
      modelId: 'gemma-4-e2b',
    })
    await Promise.resolve()
    await Promise.resolve()
    const loadCaller = (sendMessageMock.mock.calls[0][0] as { caller: string }).caller
    sendMessageMock.mockClear()

    port.receive({ type: 'divinci:abort', requestId: 'req-3' })
    await Promise.resolve()
    expect(sendMessageMock).toHaveBeenCalledOnce()
    expect(sendMessageMock.mock.calls[0][0]).toMatchObject({
      type: 'internal:abort',
      requestId: 'req-3',
      caller: loadCaller,
    })
  })

  it('forward failure surfaces a divinci:error back on the port', async () => {
    const port = makePort('https://chat.divinci.app')
    emitConnect(port)
    sendMessageMock.mockRejectedValueOnce(new Error('offscreen offline'))

    port.receive({
      type: 'divinci:chat',
      requestId: 'req-fail',
      modelId: 'gemma-4-e2b',
      messages: [{ role: 'user', content: 'x' }],
    })
    // Wait for the rejection chain.
    await new Promise((r) => setTimeout(r, 0))

    const errEvent = port.postMessages.find((m) => m.type === 'divinci:error')
    expect(errEvent).toBeDefined()
    expect(errEvent).toMatchObject({
      type: 'divinci:error',
      requestId: 'req-fail',
      fatal: false,
    })
  })
})

describe('external-bridge: caller isolation across ports', () => {
  it('assigns distinct caller ids to two concurrent ports', async () => {
    const portA = makePort('https://chat.divinci.app')
    const portB = makePort('https://chat.divinci.app')
    emitConnect(portA)
    emitConnect(portB)

    portA.receive({
      type: 'divinci:load',
      requestId: 'rA',
      modelId: 'gemma-4-e2b',
    })
    portB.receive({
      type: 'divinci:load',
      requestId: 'rB',
      modelId: 'gemma-4-e2b',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(sendMessageMock).toHaveBeenCalledTimes(2)
    const callerA = (sendMessageMock.mock.calls[0][0] as { caller: string }).caller
    const callerB = (sendMessageMock.mock.calls[1][0] as { caller: string }).caller
    expect(callerA).not.toBe(callerB)
  })

  it('routes an internal:event back ONLY to the matching caller port', async () => {
    const portA = makePort('https://chat.divinci.app')
    const portB = makePort('https://chat.divinci.app')
    emitConnect(portA)
    emitConnect(portB)

    portA.receive({
      type: 'divinci:load',
      requestId: 'rA',
      modelId: 'gemma-4-e2b',
    })
    portB.receive({
      type: 'divinci:load',
      requestId: 'rB',
      modelId: 'gemma-4-e2b',
    })
    await Promise.resolve()
    await Promise.resolve()

    const callerA = (sendMessageMock.mock.calls[0][0] as { caller: string }).caller

    // Drop the pong each port got from a hypothetical earlier divinci:ping
    // (not relevant here — only divinci:load was sent — but normalize).
    portA.postMessages.length = 0
    portB.postMessages.length = 0

    emitInternalEvent({
      type: 'internal:event',
      caller: callerA,
      event: {
        type: 'divinci:chat-token',
        requestId: 'rA',
        delta: 'hello',
      },
    })

    expect(portA.postMessages).toHaveLength(1)
    expect(portA.postMessages[0]).toMatchObject({
      type: 'divinci:chat-token',
      delta: 'hello',
    })
    expect(portB.postMessages).toHaveLength(0)
  })

  it('drops an internal:event addressed to an unknown caller (no throw)', () => {
    expect(() =>
      emitInternalEvent({
        type: 'internal:event',
        caller: 'nobody-here',
        event: {
          type: 'divinci:chat-token',
          requestId: 'r-ghost',
          delta: 'whoops',
        },
      }),
    ).not.toThrow()
  })

  it('ignores non-internal:event messages on the same listener channel', () => {
    const portA = makePort('https://chat.divinci.app')
    emitConnect(portA)
    // Some other Chrome runtime message that isn't ours.
    expect(() =>
      emitInternalEvent({
        type: 'internal:status-response',
      } as unknown as InternalEvent),
    ).not.toThrow()
    expect(portA.postMessages).toHaveLength(0)
  })
})

describe('external-bridge: disconnect cleanup', () => {
  it('removes the caller on disconnect and forwards a wildcard abort', async () => {
    const port = makePort('https://chat.divinci.app')
    emitConnect(port)
    port.receive({
      type: 'divinci:load',
      requestId: 'r1',
      modelId: 'gemma-4-e2b',
    })
    await Promise.resolve()
    await Promise.resolve()
    const caller = (sendMessageMock.mock.calls[0][0] as { caller: string }).caller
    sendMessageMock.mockClear()

    port.triggerDisconnect()
    // The disconnect handler fires sendMessage in fire-and-forget mode.
    expect(sendMessageMock).toHaveBeenCalledOnce()
    expect(sendMessageMock.mock.calls[0][0]).toMatchObject({
      type: 'internal:abort',
      requestId: '*',
      caller,
    })

    // After disconnect, an internal:event for that caller is silently dropped.
    sendMessageMock.mockClear()
    emitInternalEvent({
      type: 'internal:event',
      caller,
      event: {
        type: 'divinci:chat-token',
        requestId: 'r1',
        delta: 'late',
      },
    })
    expect(port.postMessages.find((m) => m.type === 'divinci:chat-token')).toBeUndefined()
  })
})
