import { describe, it, expect, vi } from 'vitest'
import { createLoadWatchdog } from '@/ui/load-watchdog'

/** Deterministic stand-in for setTimeout/clearTimeout. */
function fakeTimers() {
  let next = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++
        pending.set(id, { fn, ms })
        return id
      },
      clearTimeout: (h: unknown) => {
        pending.delete(h as number)
      },
    },
    /** Fire every armed timer, as if its delay elapsed. */
    fire: () => {
      for (const [id, t] of [...pending]) {
        pending.delete(id)
        t.fn()
      }
    },
    armed: () => pending.size,
    lastDelay: () => [...pending.values()].at(-1)?.ms,
  }
}

describe('load stall watchdog', () => {
  it('fires when a load goes silent past the threshold', () => {
    const onStall = vi.fn()
    const t = fakeTimers()
    const wd = createLoadWatchdog({
      thresholdMs: 120_000,
      onStall,
      isLoading: () => true,
      timers: t.timers,
    })

    wd.arm()
    expect(t.lastDelay()).toBe(120_000)
    t.fire()
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire while progress keeps arriving', () => {
    const onStall = vi.fn()
    const t = fakeTimers()
    const wd = createLoadWatchdog({ thresholdMs: 1000, onStall, isLoading: () => true, timers: t.timers })

    wd.arm()
    // Each progress tick re-arms, discarding the previous timer. Only ONE timer
    // is ever outstanding — otherwise a long download would accumulate timers
    // and the first one to elapse would kill a perfectly healthy load.
    for (let i = 0; i < 5; i++) {
      wd.arm()
      expect(t.armed()).toBe(1)
    }
    expect(onStall).not.toHaveBeenCalled()
  })

  it('does not fire after disarm (load-done, or a reported error)', () => {
    const onStall = vi.fn()
    const t = fakeTimers()
    const wd = createLoadWatchdog({ thresholdMs: 1000, onStall, isLoading: () => true, timers: t.timers })

    wd.arm()
    wd.disarm()
    t.fire()
    expect(onStall).not.toHaveBeenCalled()
    expect(t.armed()).toBe(0)
  })

  it('does not fire if the load finished between the timer and its callback', () => {
    // The surface flips isLoading synchronously on load-done; the timer may
    // already be queued. Firing then would clear a healthy state and show an
    // error for a load that actually succeeded.
    const onStall = vi.fn()
    const t = fakeTimers()
    let loading = true
    const wd = createLoadWatchdog({
      thresholdMs: 1000,
      onStall,
      isLoading: () => loading,
      timers: t.timers,
    })

    wd.arm()
    loading = false
    t.fire()
    expect(onStall).not.toHaveBeenCalled()
  })

  it('disarm is idempotent', () => {
    const t = fakeTimers()
    const wd = createLoadWatchdog({ thresholdMs: 1, onStall: () => {}, isLoading: () => true, timers: t.timers })
    wd.disarm()
    wd.arm()
    wd.disarm()
    wd.disarm()
    expect(t.armed()).toBe(0)
  })
})
