/**
 * Watchdog for a model load that dies WITHOUT reporting anything.
 *
 * A load that fails emits `divinci:error` and the panel renders it. A load that
 * is KILLED emits nothing: the offscreen/inference renderer dies mid-download
 * (commonly an OOM — transformers.js buffers a whole shard, so a ~1.4 GB shard
 * is a ~1.4 GB allocation), sockets close, and the surface keeps `isLoading`
 * true with the last percentage painted. From the user's side a dead download
 * is indistinguishable from a slow one, forever. Observed 2026-08-20: the panel
 * sat at "38% (556 MB / 1.42 GB)" with no connection open and no process
 * holding a buffer.
 *
 * Progress events arrive per chunk, so a long gap while loading means the
 * producer is gone. Kept as its own module — with injected timers — so the
 * behaviour is unit-testable; wired into a DOM-heavy panel it would not be.
 */

export interface LoadWatchdogTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LoadWatchdogOptions {
  /** Silence longer than this, while loading, is treated as a dead producer. */
  thresholdMs: number
  /** Called once per stall. The surface clears its loading state and explains. */
  onStall(): void
  /** Whether a load is still believed to be in flight. */
  isLoading(): boolean
  timers?: LoadWatchdogTimers
}

export interface LoadWatchdog {
  /** (Re)start the timer — call on load start and on every progress tick. */
  arm(): void
  /** Stop the timer — call on load-done and on a reported error. */
  disarm(): void
}

export function createLoadWatchdog(opts: LoadWatchdogOptions): LoadWatchdog {
  const timers: LoadWatchdogTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  let handle: unknown = null

  const disarm = (): void => {
    if (handle !== null) {
      timers.clearTimeout(handle)
      handle = null
    }
  }

  return {
    arm(): void {
      disarm()
      handle = timers.setTimeout(() => {
        handle = null
        // Re-check: the load may have completed between the timer firing and
        // this callback running. Firing then would clear a healthy state and
        // show an error for a load that actually succeeded.
        if (!opts.isLoading()) return
        opts.onStall()
      }, opts.thresholdMs)
    },
    disarm,
  }
}
