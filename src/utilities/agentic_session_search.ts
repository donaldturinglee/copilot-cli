/**
 * Agentic session search (`searchSessionsAgentically`): pre-filters candidate
 * sessions by substring match (up to 100 sessions), upgrades lite logs, and
 * ranks relevance via `sideQuery` on the small/fast model.
 */

import type { LogOption } from '../types/logs.js'
import { safeParseJson } from './json.js'
import { extractTextContent } from './messages.js'
import { getSmallFastModel } from './model/model.js'
import { isLiteLog, loadFullLog } from './session_storage.js'
import { sideQuery } from './side_query.js'

export const MAX_TRANSCRIPT_CHARS = 2_000
export const MAX_MESSAGES_TO_SCAN = 100
export const MAX_SESSIONS_TO_SEARCH = 100

function logContainsQuery(log: LogOption, needle: string): boolean {
  const fields = [
    log.customTitle,
    log.tag,
    log.gitBranch,
    log.summary,
    log.firstPrompt,
  ]
  for (const field of fields) {
    if (field && field.toLowerCase().includes(needle)) {
      return true
    }
  }
  for (const msg of log.messages) {
    if (msg.type === 'user' || msg.type === 'assistant') {
      const text = extractTextContent(msg.message.content)
      if (text.toLowerCase().includes(needle)) {
        return true
      }
    }
  }
  return false
}

function summarizeTranscriptSnippet(log: LogOption): string {
  const msgs = log.messages
  const selected =
    msgs.length <= MAX_MESSAGES_TO_SCAN
      ? msgs
      : [...msgs.slice(0, 50), ...msgs.slice(-50)]

  const parts: string[] = []
  let total = 0
  for (const msg of selected) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    if (msg.type === 'user' && (msg.isMeta || msg.isCompactSummary)) continue
    const text = extractTextContent(msg.message.content)
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    const line = `${msg.type === 'user' ? 'U' : 'A'}: ${text.slice(0, 200)}`
    if (total + line.length > MAX_TRANSCRIPT_CHARS) {
      break
    }
    parts.push(line)
    total += line.length + 1
  }
  return parts.join(' | ')
}

/**
 * Searches `logs` for sessions matching `query` using substring pre-filtering
 * plus LLM semantic ranking via `sideQuery`.
 */
export async function searchSessionsAgentically(
  query: string,
  logs: readonly LogOption[],
  options?: {
    signal?: AbortSignal
    queryFn?: typeof sideQuery
  },
): Promise<LogOption[]> {
  const needle = query.trim().toLowerCase()
  if (!needle || logs.length === 0) {
    return [...logs]
  }

  const directMatches: LogOption[] = []
  const remainder: LogOption[] = []
  for (const log of logs) {
    if (logContainsQuery(log, needle)) {
      directMatches.push(log)
    } else {
      remainder.push(log)
    }
  }

  const candidates = [
    ...directMatches.slice(0, MAX_SESSIONS_TO_SEARCH),
    ...remainder.slice(
      0,
      Math.max(0, MAX_SESSIONS_TO_SEARCH - directMatches.length),
    ),
  ]

  const hydrated = await Promise.all(
    candidates.map(log => (isLiteLog(log) ? loadFullLog(log) : Promise.resolve(log))),
  )

  const listing = hydrated
    .map((log, idx) => {
      const title = log.customTitle ?? log.summary ?? log.firstPrompt ?? '(session)'
      const meta: string[] = []
      if (log.customTitle) meta.push(`custom title: ${log.customTitle}`)
      if (log.tag) meta.push(`tag: ${log.tag}`)
      if (log.gitBranch) meta.push(`branch: ${log.gitBranch}`)
      const snippet = summarizeTranscriptSnippet(log)
      return (
        `${idx}: ${title}` +
        (meta.length > 0 ? ` [${meta.join(', ')}]` : '') +
        (log.summary ? ` - Summary: ${log.summary}` : '') +
        (log.firstPrompt ? ` - First message: ${log.firstPrompt}` : '') +
        (snippet ? ` - Transcript: ${snippet}` : '')
      )
    })
    .join('\n')

  const queryFn = options?.queryFn ?? sideQuery
  try {
    const response = await queryFn({
      model: getSmallFastModel(),
      skipSystemPromptPrefix: true,
      maxTokens: 256,
      querySource: 'session_search',
      signal: options?.signal,
      system:
        'You search coding sessions. Prioritize matches in tags > custom titles > branch names > summaries/transcripts > semantic relevance. Return ONLY JSON: {"relevant_indices": [0, 2, ...]}.',
      messages: [
        {
          role: 'user',
          content: `Search query: ${query}\n\nSessions:\n${listing}`,
        },
      ],
    })

    const raw = extractTextContent(response.content).trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return directMatches
    }
    const parsed = safeParseJson(jsonMatch[0]) as {
      relevant_indices?: unknown
    } | null
    if (!parsed || !Array.isArray(parsed.relevant_indices)) {
      return directMatches
    }

    const picked: LogOption[] = []
    const seen = new Set<number>()
    for (const rawIdx of parsed.relevant_indices) {
      if (
        typeof rawIdx === 'number' &&
        Number.isInteger(rawIdx) &&
        rawIdx >= 0 &&
        rawIdx < hydrated.length &&
        !seen.has(rawIdx)
      ) {
        seen.add(rawIdx)
        picked.push(hydrated[rawIdx]!)
      }
    }
    return picked
  } catch {
    return directMatches
  }
}
