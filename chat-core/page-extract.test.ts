import { describe, it, expect } from 'vitest'
import { normalizePageText, PAGE_CONTENT_MAX_CHARS } from '@/chat-core/page-extract'

describe('normalizePageText', () => {
  it('collapses spaces/tabs and trims', () => {
    expect(normalizePageText('  hello   \t world  ').text).toBe('hello world')
  })

  it('squeezes 3+ blank lines to a single blank line', () => {
    expect(normalizePageText('a\n\n\n\n\nb').text).toBe('a\n\nb')
  })

  it('does not truncate content within the cap', () => {
    const r = normalizePageText('short page')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short page')
  })

  it('truncates + flags + ellipsizes when over the cap', () => {
    const r = normalizePageText('x'.repeat(PAGE_CONTENT_MAX_CHARS + 500), 100)
    expect(r.truncated).toBe(true)
    expect(r.text.endsWith('…')).toBe(true)
    expect(r.text.length).toBe(101) // 100 chars + ellipsis
  })

  it('handles empty/whitespace-only input', () => {
    expect(normalizePageText('   \n\n  ')).toEqual({ text: '', truncated: false })
    expect(normalizePageText('')).toEqual({ text: '', truncated: false })
  })
})
