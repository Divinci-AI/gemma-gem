/**
 * decideAutoWarm tests — the auto-warm crash-loop guard's pure decision.
 *
 * The whole point of the timestamp: tell a real crash (stale 'pending') from a
 * load that's merely still in flight after a normal ~30s SW eviction (recent
 * 'pending'). No chrome, no storage — pure input → decision.
 */
import { describe, it, expect } from 'vitest'
import { decideAutoWarm, WARM_PENDING_STALE_MS } from './auto-warm-decision'

const NOW = 1_000_000_000_000

describe('decideAutoWarm', () => {
  it('skips when no model is remembered', () => {
    const d = decideAutoWarm({ modelId: undefined, warmState: undefined, pendingAt: undefined, now: NOW })
    expect(d.action).toBe('skip')
  })

  it("warms on a clean prior state ('ok')", () => {
    expect(decideAutoWarm({ modelId: 'gemma-4-e2b', warmState: 'ok', pendingAt: undefined, now: NOW }).action).toBe('warm')
  })

  it('warms on first-ever run (undefined state, model remembered)', () => {
    expect(decideAutoWarm({ modelId: 'gemma-4-e2b', warmState: undefined, pendingAt: undefined, now: NOW }).action).toBe('warm')
  })

  it("skips (does NOT re-warm) when prior state is 'failed' — manual Load required", () => {
    expect(decideAutoWarm({ modelId: 'gemma-4-e2b', warmState: 'failed', pendingAt: undefined, now: NOW }).action).toBe('skip')
  })

  it("skips when prior state is 'disabled'", () => {
    expect(decideAutoWarm({ modelId: 'gemma-4-e2b', warmState: 'disabled', pendingAt: undefined, now: NOW }).action).toBe('skip')
  })

  it('DISABLES on a stale pending (older than the bound) — the crash signal', () => {
    const d = decideAutoWarm({
      modelId: 'gemma-4-e2b',
      warmState: 'pending',
      pendingAt: NOW - (WARM_PENDING_STALE_MS + 1000),
      now: NOW,
    })
    expect(d.action).toBe('disable')
  })

  it('does NOT disable on a recent pending — a load may still be in flight after an SW eviction', () => {
    const d = decideAutoWarm({
      modelId: 'gemma-4-e2b',
      warmState: 'pending',
      pendingAt: NOW - 5_000, // 5s ago — well within the bound
      now: NOW,
    })
    // Critical false-positive fix: a long legitimate load that outlived a 30s
    // eviction must not be misread as a crash.
    expect(d.action).toBe('skip')
  })

  it('treats a pending with NO timestamp (legacy build) as stale → disable', () => {
    const d = decideAutoWarm({ modelId: 'gemma-4-e2b', warmState: 'pending', pendingAt: undefined, now: NOW })
    expect(d.action).toBe('disable')
  })

  it('honors a custom staleMs bound', () => {
    const base = { modelId: 'gemma-4-e2b' as const, warmState: 'pending' as const, now: NOW }
    expect(decideAutoWarm({ ...base, pendingAt: NOW - 2000, staleMs: 1000 }).action).toBe('disable')
    expect(decideAutoWarm({ ...base, pendingAt: NOW - 500, staleMs: 1000 }).action).toBe('skip')
  })
})
