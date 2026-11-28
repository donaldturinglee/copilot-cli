/**
 * Automatic short session title generator (`generateSessionTitle`) using
 * structured JSON output via `sideQuery` on the fast/small model.
 */

import { z } from 'zod/v4'
import { logEvent } from '../services/analytics/index.js'
import type { Message } from '../types/message.js'
import { safeParseJson } from './json.js'
import { extractTextContent } from './messages.js'
import { getSmallFastModel } from './model/model.js'
import { sideQuery } from './side_query.js'

export const MAX_CONVERSATION_TEXT = 1_000

const TitleResponseSchema = z.object({
  title: z.string().min(1).max(120),
})

/**
 * Extracts concatenated human-origin `user` and `assistant` text from
 * `messages`, tail-sliced to the most recent `1,000` characters.
 */
export function extractConversationText(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.type === 'user') {
      if (msg.isMeta || msg.isCompactSummary) continue
      if (msg.origin && msg.origin.kind !== 'human') continue
      const text = extractTextContent(msg.message.content).trim()
      if (text) {
        parts.push(`User: ${text}`)
      }
    } else if (msg.type === 'assistant') {
      if (msg.isMeta || msg.isApiErrorMessage) continue
      const text = extractTextContent(msg.message.content).trim()
      if (text) {
        parts.push(`Assistant: ${text}`)
      }
    }
  }
  const combined = parts.join('\n')
  if (combined.length <= MAX_CONVERSATION_TEXT) {
    return combined
  }
  return combined.slice(-MAX_CONVERSATION_TEXT)
}

/**
 * Generates a concise 3–7 word sentence-case session title from `description`.
 */
export async function generateSessionTitle(
  description: string,
  signal?: AbortSignal,
  queryFn: typeof sideQuery = sideQuery,
): Promise<string | null> {
  const trimmed = description.trim()
  if (!trimmed) {
    return null
  }

  try {
    const response = await queryFn({
      model: getSmallFastModel(),
      skipSystemPromptPrefix: true,
      maxTokens: 128,
      querySource: 'generate_session_title',
      signal,
      system:
        'Generate a concise 3-7 word sentence-case title describing this coding session. Return JSON with a single "title" field.',
      messages: [
        {
          role: 'user',
          content: trimmed.slice(0, MAX_CONVERSATION_TEXT),
        },
      ],
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    })

    const rawText = extractTextContent(response.content).trim()
    const parsed = safeParseJson(rawText)
    const validated = TitleResponseSchema.safeParse(parsed)
    if (!validated.success) {
      return null
    }
    const title = validated.data.title.trim()
    if (!title) {
      return null
    }
    logEvent('tengu_session_title_generated', {
      titleLength: title.length,
    })
    return title
  } catch {
    return null
  }
}
