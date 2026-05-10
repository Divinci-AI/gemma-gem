import { describe, it, expect } from 'vitest'
import { clampSettings } from './settings-helpers'
import { DEFAULT_SETTINGS } from '@/shared/models'

describe('clampSettings', () => {
  it('returns the current settings unchanged when input is empty', () => {
    expect(clampSettings({}, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })

  it('does not mutate the input current object', () => {
    const current = { ...DEFAULT_SETTINGS }
    const result = clampSettings({ temperature: 0.5 }, current)
    expect(current).toEqual(DEFAULT_SETTINGS)
    expect(result).not.toBe(current)
  })

  it('updates only the provided field, preserving the rest', () => {
    const result = clampSettings({ temperature: 0.5 }, DEFAULT_SETTINGS)
    expect(result.temperature).toBe(0.5)
    expect(result.maxNewTokens).toBe(DEFAULT_SETTINGS.maxNewTokens)
  })

  it.each([
    { temp: -5, expected: 0 },
    { temp: 0, expected: 0 },
    { temp: 1.0, expected: 1.0 },
    { temp: 2, expected: 2 },
    { temp: 999, expected: 2 },
    { temp: 100.5, expected: 2 },
  ])('clamps temperature $temp → $expected', ({ temp, expected }) => {
    const result = clampSettings({ temperature: temp }, DEFAULT_SETTINGS)
    expect(result.temperature).toBe(expected)
  })

  it.each([
    { tok: 0, expected: 1 },
    { tok: -100, expected: 1 },
    { tok: 1, expected: 1 },
    { tok: 512, expected: 512 },
    { tok: 8192, expected: 8192 },
    { tok: 999_999, expected: 8192 },
  ])('clamps maxNewTokens $tok → $expected', ({ tok, expected }) => {
    const result = clampSettings({ maxNewTokens: tok }, DEFAULT_SETTINGS)
    expect(result.maxNewTokens).toBe(expected)
  })

  it('rounds non-integer maxNewTokens', () => {
    expect(clampSettings({ maxNewTokens: 100.7 }, DEFAULT_SETTINGS).maxNewTokens).toBe(101)
    expect(clampSettings({ maxNewTokens: 100.4 }, DEFAULT_SETTINGS).maxNewTokens).toBe(100)
  })

  it('rejects non-finite numbers (Infinity, NaN)', () => {
    expect(clampSettings({ temperature: NaN }, DEFAULT_SETTINGS).temperature).toBe(
      DEFAULT_SETTINGS.temperature
    )
    expect(clampSettings({ temperature: Infinity }, DEFAULT_SETTINGS).temperature).toBe(
      DEFAULT_SETTINGS.temperature
    )
    expect(clampSettings({ maxNewTokens: NaN }, DEFAULT_SETTINGS).maxNewTokens).toBe(
      DEFAULT_SETTINGS.maxNewTokens
    )
  })

  it('rejects non-number types (string, null, undefined, object)', () => {
    expect(
      clampSettings(
        { temperature: '0.5' as unknown as number, maxNewTokens: null as unknown as number },
        DEFAULT_SETTINGS
      )
    ).toEqual(DEFAULT_SETTINGS)
    expect(
      clampSettings(
        { temperature: undefined, maxNewTokens: undefined },
        DEFAULT_SETTINGS
      )
    ).toEqual(DEFAULT_SETTINGS)
  })

  it('handles both fields together', () => {
    const result = clampSettings(
      { temperature: 999, maxNewTokens: 0 },
      DEFAULT_SETTINGS
    )
    expect(result).toEqual({ temperature: 2, maxNewTokens: 1 })
  })
})
