import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isLoadable,
  modelMenuStatus,
  shouldAdoptRememberedModel,
} from './model-availability'
import { MODELS, firstAvailableModelId, type ModelConfig, type ModelId } from './models'

const gated = { id: 'g', label: 'Gated', downloadSize: '~1 GB', comingSoon: true } as unknown as ModelConfig
const open_ = { id: 'o', label: 'Open', downloadSize: '~2 GB' } as unknown as ModelConfig

describe('isLoadable', () => {
  it('rejects a gated model', () => {
    expect(isLoadable(gated)).toBe(false)
  })

  it('rejects an unknown model', () => {
    // An id we do not recognise must not be loadable — otherwise a stale or
    // hand-edited storage value walks straight past the gate.
    expect(isLoadable(undefined)).toBe(false)
  })

  it('accepts a model with comingSoon absent or false', () => {
    expect(isLoadable(open_)).toBe(true)
    expect(isLoadable({ ...open_, comingSoon: false } as ModelConfig)).toBe(true)
  })
})

describe('shouldAdoptRememberedModel', () => {
  const models = { g: gated, o: open_ } as unknown as Record<string, ModelConfig>

  it('ignores a remembered model that is gated', () => {
    // The regression that matters: adopting it leaves the surface offering only
    // an action that wedges it.
    expect(shouldAdoptRememberedModel('g' as ModelId, 'o' as ModelId, models)).toBe(false)
  })

  it('ignores an unknown remembered id', () => {
    expect(shouldAdoptRememberedModel('nope' as ModelId, 'o' as ModelId, models)).toBe(false)
  })

  it('ignores nothing-remembered', () => {
    expect(shouldAdoptRememberedModel(undefined, 'o' as ModelId, models)).toBe(false)
  })

  it('ignores a remembered model already selected', () => {
    expect(shouldAdoptRememberedModel('o' as ModelId, 'o' as ModelId, models)).toBe(false)
  })

  it('adopts a known, loadable, different model', () => {
    expect(shouldAdoptRememberedModel('o' as ModelId, 'g' as ModelId, models)).toBe(true)
  })
})

describe('modelMenuStatus', () => {
  it('marks a gated model disabled and labels it', () => {
    expect(modelMenuStatus(gated, false)).toEqual({ label: 'Coming soon', disabled: true })
  })

  it('a gated model stays disabled even if somehow resident', () => {
    // Defence in depth: residency must never re-enable a gated row.
    expect(modelMenuStatus(gated, true)).toEqual({ label: 'Coming soon', disabled: true })
  })

  it('shows residency, then download size, for loadable models', () => {
    expect(modelMenuStatus(open_, true)).toEqual({ label: 'loaded', disabled: false })
    expect(modelMenuStatus(open_, false)).toEqual({ label: '~2 GB', disabled: false })
  })
})

describe('the real registry', () => {
  it('never offers a gated model as the default selection', () => {
    expect(isLoadable(MODELS[firstAvailableModelId()])).toBe(true)
  })

  it('LFM2.5 is gated', () => {
    // Not a style preference. Un-gating it while the ORT alias is reverted
    // produces a load that never completes and never errors, and wxt.config.ts
    // fails the build on exactly this condition.
    expect(MODELS['lfm2.5-230m'].comingSoon).toBe(true)
  })

  it('every gated model still declares a size and label', () => {
    for (const m of Object.values(MODELS)) {
      if (!m.comingSoon) continue
      expect(m.label, `${m.id} label`).toBeTruthy()
      expect(m.downloadSize, `${m.id} downloadSize`).toBeTruthy()
    }
  })
})

describe('the gate is enforced through the shared helpers, not inline', () => {
  // Each of these was an inline `cfg.comingSoon` test inside DOM-heavy code with
  // no harness. Re-inlining one would pass every behavioural test above while
  // silently dropping out of coverage, so assert the call sites delegate.
  const panel = readFileSync(resolve(__dirname, '../ui/chat-panel.ts'), 'utf-8')
  const popup = readFileSync(resolve(__dirname, '../entrypoints/popup/main.ts'), 'utf-8')
  const codeOnly = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')

  it('the panel delegates all three of its checks', () => {
    const code = codeOnly(panel)
    expect(code).toContain('shouldAdoptRememberedModel(')
    expect(code).toContain('modelMenuStatus(')
    expect(code).toContain('isLoadable(')
    expect(code, 'panel should not test comingSoon inline').not.toMatch(/\.comingSoon/)
  })

  it('the popup delegates its check', () => {
    const code = codeOnly(popup)
    expect(code).toContain('isLoadable(')
    expect(code, 'popup should not test comingSoon inline').not.toMatch(/\.comingSoon/)
  })
})
