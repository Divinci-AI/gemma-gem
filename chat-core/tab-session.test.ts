import { describe, it, expect } from 'vitest'
import { resolveActiveConvId, setTabActive } from '@/chat-core/tab-session'

describe('resolveActiveConvId', () => {
  it('uses the per-tab pointer in tab mode', () => {
    expect(
      resolveActiveConvId({
        globalMode: false,
        tabId: 7,
        globalConvId: 'G',
        tabMap: { '7': 'T7', '9': 'T9' },
      }),
    ).toBe('T7')
  })

  it('returns null in tab mode when this tab has no pointer yet', () => {
    expect(
      resolveActiveConvId({ globalMode: false, tabId: 3, globalConvId: 'G', tabMap: {} }),
    ).toBeNull()
  })

  it('uses the shared global pointer in global mode (ignoring the tab map)', () => {
    expect(
      resolveActiveConvId({
        globalMode: true,
        tabId: 7,
        globalConvId: 'G',
        tabMap: { '7': 'T7' },
      }),
    ).toBe('G')
  })

  it('falls back to the global pointer when the tabId is unknown', () => {
    expect(
      resolveActiveConvId({ globalMode: false, tabId: null, globalConvId: 'G', tabMap: { '7': 'T7' } }),
    ).toBe('G')
  })
})

describe('setTabActive', () => {
  it('sets a tab pointer without mutating the input', () => {
    const map = { '1': 'a' }
    const next = setTabActive(map, 2, 'b')
    expect(next).toEqual({ '1': 'a', '2': 'b' })
    expect(map).toEqual({ '1': 'a' }) // unchanged
  })

  it('overwrites an existing tab pointer', () => {
    expect(setTabActive({ '1': 'a' }, 1, 'z')).toEqual({ '1': 'z' })
  })
})
