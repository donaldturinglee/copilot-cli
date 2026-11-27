/**
 * Shared transcript compaction, action formatting, and XML response parsing
 * utilities for the permission classifiers (`yolo_classifier` & `bash_classifier`).
 */

import type { Message } from '../../types/message.js'
import { jsonStringify } from '../slow_operations.js'

export interface CompactTranscriptEntry {
  role: 'user' | 'assistant'
  content: string
}

const MAX_BLOCK_CHARS = 1_500
const MAX_TRANSCRIPT_CHARS = 32_000

/**
 * Truncates text deterministically with a clear omission marker.
 */
export function truncateForClassifier(text: string, maxChars = MAX_BLOCK_CHARS): string {
  if (text.length <= maxChars) {
    return text
  }
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.max(0, maxChars - head - 32)
  return `${text.slice(0, head)}\n...[truncated ${text.length - head - tail} chars]...\n${text.slice(text.length - tail)}`
}

/**
 * Compacts conversation messages into a bounded classifier transcript containing
 * user intents and assistant tool calls while excluding raw untrusted tool
 * output payloads (defending against prompt injection inside tool results).
 */
export function buildClassifierTranscript(
  messages: readonly Message[],
  maxChars = MAX_TRANSCRIPT_CHARS,
): { entries: CompactTranscriptEntry[]; totalChars: number; truncated: boolean } {
  const entries: CompactTranscriptEntry[] = []

  for (const msg of messages) {
    if (msg.type === 'user') {
      if (msg.isMeta) continue
      const content = msg.message.content
      if (typeof content === 'string') {
        const trimmed = content.trim()
        if (trimmed) {
          entries.push({ role: 'user', content: truncateForClassifier(trimmed) })
        }
      } else if (Array.isArray(content)) {
        const texts: string[] = []
        for (const block of content) {
          if (block.type === 'text' && block.text.trim()) {
            texts.push(block.text.trim())
          }
          // Intentionally omit raw `tool_result` bodies to prevent untrusted
          // file/web contents from prompt-injecting the classifier.
        }
        if (texts.length > 0) {
          entries.push({
            role: 'user',
            content: truncateForClassifier(texts.join('\n')),
          })
        }
      }
    } else if (msg.type === 'assistant') {
      const parts: string[] = []
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          parts.push(truncateForClassifier(block.text.trim(), 500))
        } else if (block.type === 'tool_use') {
          parts.push(
            `[tool_use ${block.name}: ${truncateForClassifier(jsonStringify(block.input), 400)}]`,
          )
        }
      }
      if (parts.length > 0) {
        entries.push({ role: 'assistant', content: parts.join('\n') })
      }
    }
  }

  let totalChars = 0
  let truncated = false
  const kept: CompactTranscriptEntry[] = []
  // Keep most recent turns plus the original user request if present
  const firstUser = entries.find(e => e.role === 'user')
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    const cost = entry.content.length + 16
    if (totalChars + cost > maxChars && kept.length > 0) {
      truncated = true
      break
    }
    kept.unshift(entry)
    totalChars += cost
  }

  if (firstUser && kept[0] !== firstUser) {
    kept.unshift(firstUser)
    totalChars += firstUser.content.length + 16
  }

  return { entries: kept, totalChars, truncated }
}

/**
 * Formats a proposed tool call into a canonical classifier prompt payload.
 */
export function formatActionForClassifier(
  toolName: string,
  input: unknown,
  customSummary?: string,
): string {
  const serialized =
    customSummary !== undefined
      ? customSummary
      : typeof input === 'string'
        ? input
        : jsonStringify(input)
  return `Tool: ${toolName}\nInput: ${truncateForClassifier(serialized, 4_000)}`
}

/**
 * Extracts XML tag text from classifier output (case-insensitive).
 */
export function extractClassifierXmlTag(
  text: string,
  tagName: string,
): string | undefined {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i')
  const match = text.match(regex)
  return match?.[1]?.trim()
}

/**
 * Parses a classifier XML response (`<block>yes|no</block>` + `<reason>...</reason>`).
 * Fails closed (`shouldBlock: true`) when the response cannot be parsed cleanly.
 */
export function parseYoloClassifierXml(rawText: string): {
  shouldBlock: boolean
  reason: string
  thinking?: string
  parseError?: boolean
} {
  const thinking = extractClassifierXmlTag(rawText, 'thinking')
  const blockTag = extractClassifierXmlTag(rawText, 'block')?.toLowerCase()
  const reasonTag = extractClassifierXmlTag(rawText, 'reason')

  if (blockTag === 'no' || blockTag === 'false' || blockTag === 'allow') {
    return {
      shouldBlock: false,
      reason: reasonTag || 'Action aligns with user intent and security policy.',
      ...(thinking ? { thinking } : {}),
    }
  }

  if (blockTag === 'yes' || blockTag === 'true' || blockTag === 'block') {
    return {
      shouldBlock: true,
      reason: reasonTag || 'Action blocked by auto-mode security classifier.',
      ...(thinking ? { thinking } : {}),
    }
  }

  // Fail closed when output does not contain a clear decision tag
  return {
    shouldBlock: true,
    reason:
      reasonTag ||
      'Auto-mode classifier produced an unparseable response; failing closed.',
    ...(thinking ? { thinking } : {}),
    parseError: true,
  }
}
