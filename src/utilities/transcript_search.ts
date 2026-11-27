import type { Message } from '../types/message.js'
import { stripSystemReminders } from './display_tags.js'

const searchCache = new WeakMap<Message, string>()

/**
 * Extract normalized lowercase searchable text from any `Message` for `/`
 * incremental transcript search.
 */
export function extractMessageSearchText(msg: Message): string {
  const hit = searchCache.get(msg)
  if (hit !== undefined) return hit

  let text = ''
  if (msg.type === 'user') {
    const content = msg.message.content
    if (typeof content === 'string') {
      text = stripSystemReminders(content)
    } else if (Array.isArray(content)) {
      text = content
        .map(block => {
          if (block.type === 'text') return stripSystemReminders(block.text)
          if (block.type === 'tool_result') {
            return typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map(c => (c.type === 'text' ? c.text : ''))
                    .join(' ')
                : ''
          }
          return ''
        })
        .join('\n')
    }
  } else if (msg.type === 'assistant') {
    const content = msg.message.content
    if (Array.isArray(content)) {
      text = content
        .map(block => {
          if (block.type === 'text') return block.text
          if (block.type === 'thinking') return block.thinking
          if (block.type === 'tool_use') {
            return `${block.name} ${JSON.stringify(block.input ?? {})}`
          }
          return ''
        })
        .join('\n')
    }
  } else if (msg.type === 'system') {
    if ('content' in msg && typeof msg.content === 'string') {
      text = msg.content
    }
  }

  const lowered = text.toLowerCase()
  searchCache.set(msg, lowered)
  return lowered
}

export function findTranscriptMatches(
  messages: readonly Message[],
  query: string,
): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const indices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (extractMessageSearchText(messages[i]!).includes(q)) {
      indices.push(i)
    }
  }
  return indices
}
