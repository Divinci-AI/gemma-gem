/**
 * Internal-bridge tests.
 *
 * Locks down the same-extension boundary between the in-page sidebar
 * content script and the offscreen doc:
 *  - Only ports named SIDEBAR_PORT_NAME are accepted (ignore everything else).
 *  - Per-port caller-id assignment + isolation (namespaced `s<n>-sidebar`).
 *  - Request forwarding to the offscreen (shared port-router path).
 *  - InternalEvent envelope routing back to the matching port only.
 *  - Disconnect cleanup (caller removed; wildcard abort forwarded).
 *
 * No transformers.js, no WebGPU. We mock chrome.runtime + offscreen-manager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ensureOffscreenDocumentMock } = vi.hoisted(() => ({
  ensureOffscreenDocumentMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./offscreen-manager', () => ({
  ensureOffscreenDocument: ensureOffscreenDocumentMock,
}))

vi.mock('@/shared/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

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

const onConnectHook = makeHook<chrome.runtime.Port>()
const onMessageHook = makeHook<unknown>()
const sendMessageMock = vi.fn().mockResolvedValue(undefined)
const getManifestMock = vi.fn().mockReturnValue({ version: '0.1.2-test' })

;(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onConnect: onConnectHook,
    onMessage: onMessageHook,
    sendMessage: sendMessageMock,
    getManifest: getManifestMock,
  },
}

import { setupInternalBridge, SIDEBAR_PORT_NAME } from './internal-bridge'
import type {
  DivinciExternalEvent,
  DivinciExternalRequest,
  InternalEvent,
} from '@/shared/messages'

interface FakePort {
  name: string
  postMessages: DivinciExternalEvent[]
  messageListeners: Array<(msg: DivinciExternalRequest) => void>
  disconnectListeners: Array<() => void>
  onMessage: { addListener: (fn: (msg: DivinciExternalRequest) => void) => void }
  onDisconnect: { addListener: (fn: () => void) => void }
  postMessage: (msg: DivinciExternalEvent) => void
  disconnect: ReturnType<typeof vi.fn>
  receive: (msg: DivinciExternalRequest) => void
  triggerDisconnect: () => void
}

function makePort(name = SIDEBAR_PORT_NAME): FakePort {
  const port: FakePort = {
    name,
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
  for (const fn of onConnectHook.getListeners()) {
    fn(port as unknown as chrome.runtime.Port)
  }
}

function emitInternalEvent(envelope: InternalEvent): void {
  for (const fn of onMessageHook.getListeners()) fn(envelope)
}

beforeEach(() => {
  onConnectHook.getListeners().forEach((fn) =>
    onConnectHook.removeListener(fn as Listener<chrome.runtime.Port>),
  )
  onMessageHook.getListeners().forEach((fn) =>
    onMessageHook.removeListener(fn as Listener<unknown>),
  )
  sendMessageMock.mockClear()
  ensureOffscreenDocumentMock.mockClear()
  setupInternalBridge()
})

describe('internal-bridge: port-name gating', () => {
  it('accepts a port named divinci-sidebar', () => {
    const port = makePort()
    emitConnect(port)
    expect(port.messageListeners.length).toBe(1)
  })

  it('ignores ports with any other name (e.g. HMR ports)', () => {
    const port = makePort('vite-hmr')
    emitConnect(port)
    expect(port.messageListeners.length).toBe(0)
    expect(port.disconnect).not.toHaveBeenCalled()
  })
})

describe('internal-bridge: request routing', () => {
  it('divinci:ping responds with a pong over the port', async () => {
    const port = makePort()
    emitConnect(port)
    port.receive({ type: 'divinci:ping' })
    await Promise.resolve()
    expect(port.postMessages[0]).toMatchObject({
      type: 'divinci:pong',
      extensionVersion: '0.1.2-test',
    })
  })

  it('divinci:chat forwards an internal:chat with a sidebar-namespaced caller', async () => {
    const port = makePort()
    emitConnect(port)
    port.receive({
      type: 'divinci:chat',
      requestId: 'rq-1',
      modelId: 'gemma-4-e2b',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(ensureOffscreenDocumentMock).toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledOnce()
    const sent = sendMessageMock.mock.calls[0][0] as { type: string; caller: string }
    expect(sent.type).toBe('internal:chat')
    expect(sent.caller).toMatch(/^s\d+-sidebar$/)
  })
})

describe('internal-bridge: caller isolation + event routing', () => {
  it('routes an internal:event back ONLY to the matching caller port', async () => {
    const portA = makePort()
    const portB = makePort()
    emitConnect(portA)
    emitConnect(portB)

    portA.receive({ type: 'divinci:load', requestId: 'rA', modelId: 'gemma-4-e2b' })
    portB.receive({ type: 'divinci:load', requestId: 'rB', modelId: 'gemma-4-e2b' })
    await Promise.resolve()
    await Promise.resolve()

    const callerA = (sendMessageMock.mock.calls[0][0] as { caller: string }).caller
    const callerB = (sendMessageMock.mock.calls[1][0] as { caller: string }).caller
    expect(callerA).not.toBe(callerB)

    portA.postMessages.length = 0
    portB.postMessages.length = 0

    emitInternalEvent({
      type: 'internal:event',
      caller: callerA,
      event: { type: 'divinci:chat-token', requestId: 'rA', delta: 'hello' },
    })

    expect(portA.postMessages).toHaveLength(1)
    expect(portA.postMessages[0]).toMatchObject({ type: 'divinci:chat-token', delta: 'hello' })
    expect(portB.postMessages).toHaveLength(0)
  })

  it('drops an internal:event addressed to an unknown caller (no throw)', () => {
    expect(() =>
      emitInternalEvent({
        type: 'internal:event',
        caller: 'c1-https://chat.divinci.app', // external caller, not ours
        event: { type: 'divinci:chat-token', requestId: 'x', delta: 'nope' },
      }),
    ).not.toThrow()
  })
})

describe('internal-bridge: disconnect cleanup', () => {
  it('removes the caller and forwards a wildcard abort on disconnect', async () => {
    const port = makePort()
    emitConnect(port)
    port.receive({ type: 'divinci:load', requestId: 'r1', modelId: 'gemma-4-e2b' })
    await Promise.resolve()
    await Promise.resolve()
    const caller = (sendMessageMock.mock.calls[0][0] as { caller: string }).caller
    sendMessageMock.mockClear()

    port.triggerDisconnect()
    expect(sendMessageMock).toHaveBeenCalledOnce()
    expect(sendMessageMock.mock.calls[0][0]).toMatchObject({
      type: 'internal:abort',
      requestId: '*',
      caller,
    })

    // After disconnect, an internal:event for that caller is silently dropped.
    port.postMessages.length = 0
    emitInternalEvent({
      type: 'internal:event',
      caller,
      event: { type: 'divinci:chat-token', requestId: 'r1', delta: 'late' },
    })
    expect(port.postMessages).toHaveLength(0)
  })
})
