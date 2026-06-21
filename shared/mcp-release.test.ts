import { describe, it, expect } from 'vitest'
import { toggleMcpId, releaseEditAction, forkTitleFor } from './mcp-release'

describe('toggleMcpId', () => {
  it('appends a new id when turning on', () => {
    expect(toggleMcpId(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c'])
  })
  it('removes an id when turning off', () => {
    expect(toggleMcpId(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c'])
  })
  it('does not duplicate an already-present id when turning on', () => {
    expect(toggleMcpId(['a', 'b'], 'b', true)).toEqual(['a', 'b'])
  })
  it('is a no-op when turning off an absent id', () => {
    expect(toggleMcpId(['a', 'b'], 'z', false)).toEqual(['a', 'b'])
  })
  it('turning on after off yields a clean single entry', () => {
    const off = toggleMcpId(['a', 'b'], 'a', false)
    expect(off).toEqual(['b'])
    expect(toggleMcpId(off, 'a', true)).toEqual(['b', 'a'])
  })
  it('does not mutate the input array', () => {
    const input = ['a', 'b']
    toggleMcpId(input, 'c', true)
    expect(input).toEqual(['a', 'b'])
  })
})

describe('releaseEditAction', () => {
  it('edits a draft in place', () => {
    expect(releaseEditAction('draft')).toBe('edit')
  })
  it('forks anything published', () => {
    expect(releaseEditAction('published')).toBe('fork')
  })
  it('forks unknown/undefined statuses (safe default — never PATCH a non-draft)', () => {
    expect(releaseEditAction('deprecated')).toBe('fork')
    expect(releaseEditAction(undefined)).toBe('fork')
    expect(releaseEditAction('')).toBe('fork')
  })
})

describe('forkTitleFor', () => {
  it('appends a distinct suffix so the fork title differs from the parent', () => {
    expect(forkTitleFor('My Release')).toBe('My Release (MCP edit)')
  })
  it('trims and falls back for empty/whitespace/undefined titles', () => {
    expect(forkTitleFor('  Spaced  ')).toBe('Spaced (MCP edit)')
    expect(forkTitleFor('')).toBe('Release (MCP edit)')
    expect(forkTitleFor('   ')).toBe('Release (MCP edit)')
    expect(forkTitleFor(undefined)).toBe('Release (MCP edit)')
  })
  it('never equals the parent title (the model rejects same-title forks)', () => {
    for (const t of ['A', 'Release', 'X (MCP edit)']) {
      expect(forkTitleFor(t)).not.toBe(t)
    }
  })
})
