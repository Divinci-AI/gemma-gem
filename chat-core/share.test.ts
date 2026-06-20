import { describe, it, expect } from 'vitest'
import { conversationToMarkdown, conversationToJson, filenameSlug } from '@/chat-core/share'
import type { StoredConversation } from '@/chat-core/transcript-store'

function conv(over: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id: 'c1',
    title: 'Sky lights',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [
      { id: 'm0', role: 'system', content: 'page context', createdAt: 1000 },
      { id: 'm1', role: 'user', content: 'Hi', createdAt: 1001 },
      { id: 'm2', role: 'assistant', content: '**Hello!**', createdAt: 1002 },
    ],
    ...over,
  }
}

describe('conversationToMarkdown', () => {
  it('renders title + You/Assistant labels and skips system messages', () => {
    const md = conversationToMarkdown(conv())
    expect(md).toContain('# Sky lights')
    expect(md).toContain('**You:**')
    expect(md).toContain('Hi')
    expect(md).toContain('**Assistant:**')
    expect(md).toContain('**Hello!**')
    expect(md).not.toContain('page context') // system skipped
  })
})

describe('conversationToJson', () => {
  it('emits a re-importable shape (no system role excluded — full fidelity)', () => {
    const parsed = JSON.parse(conversationToJson(conv()))
    expect(parsed.exportedFrom).toBe('divinci-local')
    expect(parsed.title).toBe('Sky lights')
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[2]).toMatchObject({ role: 'assistant', content: '**Hello!**' })
  })
})

describe('filenameSlug', () => {
  it('slugifies and caps length', () => {
    expect(filenameSlug('Sky lights!! ☄️')).toBe('sky-lights')
    expect(filenameSlug('')).toBe('divinci-chat')
    expect(filenameSlug('x'.repeat(80)).length).toBeLessThanOrEqual(40)
  })
})
