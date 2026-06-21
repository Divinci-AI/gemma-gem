import type { WarmState } from '@/shared/models'

/**
 * How long a 'pending' auto-warm may sit before the startup guard treats it as
 * a crash rather than an in-flight load.
 *
 * Auto-warm only ever loads a model the user has ALREADY downloaded once (it
 * fires off STORAGE_KEY_MODEL, set only after a manual Load), so the load is
 * normally a cache-hit VRAM load — seconds to ~1 min. The first-ever multi-
 * minute download is always a manual Load (caller !== 'autowarm'), which never
 * sets 'pending'. 5 min is comfortably above the auto-warm load time while
 * still re-detecting a real crash on the next startup after the window lapses.
 */
export const WARM_PENDING_STALE_MS = 5 * 60 * 1000

export type AutoWarmDecision =
  | { action: 'skip'; reason: string }
  | { action: 'warm'; reason: string }
  | { action: 'disable'; reason: string }

/**
 * Pure decision for the auto-warm crash-loop guard. Extracted from the SW so it
 * can be unit-tested without the chrome/offscreen stack.
 *
 *   - no remembered model            -> skip
 *   - prior state 'disabled'/'failed'-> skip (manual Load required to re-enable)
 *   - prior state 'pending':
 *       - stale (older than staleMs, or no timestamp) -> disable  (crash signal)
 *       - recent (within staleMs)                     -> skip     (load may still
 *                                                        be in flight after an
 *                                                        SW eviction; don't
 *                                                        re-dispatch, don't
 *                                                        disable)
 *   - otherwise ('ok' / undefined)   -> warm
 */
export function decideAutoWarm(input: {
  modelId: string | undefined
  warmState: WarmState | undefined
  pendingAt: number | undefined
  now: number
  staleMs?: number
}): AutoWarmDecision {
  const { modelId, warmState, pendingAt, now } = input
  const staleMs = input.staleMs ?? WARM_PENDING_STALE_MS

  if (!modelId) return { action: 'skip', reason: 'no remembered model' }

  if (warmState === 'disabled' || warmState === 'failed') {
    return { action: 'skip', reason: `warm state '${warmState}' — manual Load required to re-enable` }
  }

  if (warmState === 'pending') {
    // No timestamp = legacy 'pending' (pre-timestamp build) or a write that lost
    // the stamp — treat as stale/crash, the conservative choice.
    const ageMs = typeof pendingAt === 'number' ? now - pendingAt : Infinity
    if (ageMs > staleMs) {
      return {
        action: 'disable',
        reason: `auto-warm has been 'pending' for ${fmtAge(ageMs)} (> ${Math.round(staleMs / 1000)}s) — the prior load almost certainly crashed`,
      }
    }
    return {
      action: 'skip',
      reason: `auto-warm 'pending' for ${fmtAge(ageMs)} — load may still be in flight after an SW eviction; not re-warming`,
    }
  }

  return { action: 'warm', reason: 'remembered model, clean prior warm state' }
}

function fmtAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'an unknown time (no timestamp)'
  return `${Math.round(ageMs / 1000)}s`
}
