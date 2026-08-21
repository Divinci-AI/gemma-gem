/**
 * Whether a model may be loaded, and how it should be presented when it may not.
 *
 * `comingSoon` is a SAFETY GATE, not a label. LFM2.5 is gated because loading it
 * wedges the surface — historically the runtime hung with no abort and no
 * watchdog, leaving the dock stuck on "Loading…" with no way back. It is also
 * load-bearing for the build: `wxt.config.ts` refuses to build when a
 * `device:'wasm'` model is un-gated while the ONNX Runtime alias it needs is
 * absent.
 *
 * The gate is enforced at four independent points — remembered-model hydration,
 * the picker, the panel's load action, and the popup card. Each was an inline
 * `cfg.comingSoon` test inside DOM-heavy code with no test harness, so any one
 * of them could be dropped silently. The decisions live here, pure, so they can
 * be tested; the call sites are thin.
 */
import { MODELS, type ModelConfig, type ModelId } from './models'

/** A model may be loaded only if we know it and it is not gated. */
export function isLoadable(cfg: ModelConfig | undefined): boolean {
  return cfg !== undefined && !cfg.comingSoon
}

/**
 * Should a remembered model id (from a prior session or the popup) replace the
 * current selection?
 *
 * A gated id must be ignored rather than adopted — adopting it would put the
 * surface into a state whose only action is one that wedges it.
 */
export function shouldAdoptRememberedModel(
  remembered: ModelId | undefined,
  current: ModelId,
  models: Record<string, ModelConfig> = MODELS,
): remembered is ModelId {
  // A type predicate, not a plain boolean: the inline check this replaced also
  // narrowed `remembered` at the call site, and losing that narrowing turns a
  // compile error into a cast.

  if (!remembered) return false
  if (remembered === current) return false
  return isLoadable(models[remembered])
}

export interface ModelMenuStatus {
  /** Right-hand text in the picker row. */
  label: string
  /** Gated models are not selectable. */
  disabled: boolean
}

/** How one model row should present itself in the picker. */
export function modelMenuStatus(cfg: ModelConfig, resident: boolean): ModelMenuStatus {
  if (cfg.comingSoon) return { label: 'Coming soon', disabled: true }
  return { label: resident ? 'loaded' : cfg.downloadSize, disabled: false }
}
