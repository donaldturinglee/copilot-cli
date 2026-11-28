/**
 * Away-from-keyboard session recap generator (`src/services/away_summary.ts`):
 * - Uses the last `30` messages plus optional Session Memory (`summary.md`)
 * - Calls the fast model via `sideQuery` to produce a concise 1-3 sentence recap
 *   for users returning after >=5 minutes away
 */

import type { UUID } from 'crypto'
import type { Message, SystemAwaySummaryMessage } from '../types/message.js'
import { randomUUID } from '../utilities/crypto.js'
import { extractTextContent } from '../utilities/messages.js'
import { getSmallFastModel } from '../utilities/model/model.js'
import { sideQuery } from '../utilities/side_query.js'
import { getSessionMemoryContent } from './session_memory/session_memory_utils.js'

export const RECENT_MESSAGE_WINDOW = 30

export type AwaySummaryQueryFn = (params: {
  prompt: string
  signal?: AbortSignal
}) => Promise<string | null>

function formatMessageForRecap(message: Message): string | null {
  if (message.type === 'user') {
    if (message.isMeta) return null
    const text = extractTextContent(message.message.content).trim()
    if (!text) return null
    return `User: ${text.slice(0, 600)}`
  }
  if (message.type === 'assistant') {
    const text = message.message.content
      .filter(b => b.type === 'text')
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim()
    if (!text) return null
    return `Assistant: ${text.slice(0, 600)}`
  }
  return null
}

/**
 * Builds the compact prompt used to generate an away-from-keyboard recap.
 */
export function buildAwaySummaryPrompt(
  messages: readonly Message[],
  sessionMemory?: string | null,
): string {
  const recent = messages
    .slice(-RECENT_MESSAGE_WINDOW)
    .map(formatMessageForRecap)
    .filter((line): line is string => Boolean(line))

  const parts: string[] = [
    'The user stepped away and is returning to this coding session.',
    'Write a crisp 1-3 sentence recap stating: (1) the high-level goal, (2) what was just finished or is in progress, and (3) the concrete next step. No preamble or bullet lists.',
  ]

  if (sessionMemory && sessionMemory.trim().length > 0) {
    parts.push(
      `Session memory summary:\n${sessionMemory.trim().slice(0, 4_000)}`,
    )
  }

  if (recent.length > 0) {
    parts.push(`Recent messages:\n${recent.join('\n')}`)
  }

  return parts.join('\n\n')
}

/**
 * Generates a 1-3 sentence welcome-back recap for the conversation, or returns
 * `null` if there is insufficient context or the request fails/aborts.
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal?: AbortSignal,
  options?: {
    queryFn?: AwaySummaryQueryFn
    sessionMemory?: string | null
  },
): Promise<string | null> {
  if (signal?.aborted || messages.length === 0) {
    return null
  }

  const hasConversation = messages.some(
    m => m.type === 'user' || m.type === 'assistant',
  )
  if (!hasConversation) {
    return null
  }

  const sessionMemory =
    options?.sessionMemory !== undefined
      ? options.sessionMemory
      : await getSessionMemoryContent()

  const prompt = buildAwaySummaryPrompt(messages, sessionMemory)

  try {
    if (options?.queryFn) {
      const raw = await options.queryFn({ prompt, signal })
      const trimmed = raw?.trim()
      return trimmed || null
    }

    const response = await sideQuery({
      model: getSmallFastModel(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 256,
      signal,
      querySource: 'away_summary',
    })

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()

    return text || null
  } catch {
    return null
  }
}

/**
 * Wraps a recap string into a `SystemAwaySummaryMessage`.
 */
export function createAwaySummaryMessage(
  content: string,
): SystemAwaySummaryMessage {
  return {
    type: 'system',
    subtype: 'away_summary',
    content,
    uuid: randomUUID() as UUID,
    timestamp: new Date().toISOString(),
  }
}
