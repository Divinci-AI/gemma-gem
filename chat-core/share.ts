/**
 * Conversation export — offline, shareable artifacts from a stored conversation.
 *
 * Pure serializers (testable in node). The download trigger + the Divinci
 * share-link (which needs the conversation mirrored to a Divinci transcript —
 * the account follow-up) live in the surface layer.
 */

import type { StoredConversation } from '@/chat-core/transcript-store'

const ROLE_LABEL: Record<string, string> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'System',
}

/** Human-readable Markdown transcript. */
export function conversationToMarkdown(conv: Pick<StoredConversation, 'title' | 'messages'>): string {
  const out: string[] = [`# ${conv.title || 'Chat'}`, '', '_Exported from Divinci Local_', '']
  for (const m of conv.messages) {
    if (m.role === 'system') continue // page-context/grounding isn't user-facing
    out.push(`**${ROLE_LABEL[m.role] ?? m.role}:**`, '', m.content.trim(), '')
  }
  return `${out.join('\n').trim()}\n`
}

/** Portable JSON (re-importable). */
export function conversationToJson(conv: StoredConversation): string {
  return `${JSON.stringify(
    {
      title: conv.title,
      exportedFrom: 'divinci-local',
      createdAt: conv.createdAt,
      messages: conv.messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    },
    null,
    2,
  )}\n`
}

/** A filesystem-safe slug for the download filename. */
export function filenameSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'divinci-chat'
}
