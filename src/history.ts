import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { getCwd } from './utilities/cwd.js'
import { getClaudeConfigHomeDir } from './utilities/env_utils.js'

export type PromptHistoryEntry = {
  display: string
  pastedContents?: Record<string, string>
  timestamp: number
  project?: string
  sessionId?: string
}

const MAX_HISTORY_ENTRIES = 1000

export function getHistoryFilePath(overridePath?: string): string {
  if (overridePath) return overridePath
  return join(getClaudeConfigHomeDir(), 'history.jsonl')
}

export function appendHistory(
  display: string,
  options?: {
    historyPath?: string
    pastedContents?: Record<string, string>
    project?: string
    sessionId?: string
    timestamp?: number
  },
): PromptHistoryEntry | null {
  const trimmed = display.trim()
  if (!trimmed) return null

  const entry: PromptHistoryEntry = {
    display: trimmed,
    ...(options?.pastedContents &&
    Object.keys(options.pastedContents).length > 0
      ? { pastedContents: options.pastedContents }
      : {}),
    timestamp: options?.timestamp ?? Date.now(),
    project: options?.project ?? getCwd(),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
  }

  const filePath = getHistoryFilePath(options?.historyPath)
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // Non-fatal if history file is not writable
  }
  return entry
}

/**
 * Read prompt history newest-first with consecutive duplicate elimination.
 */
export function readHistory(options?: {
  historyPath?: string
  limit?: number
  projectOnly?: string
}): PromptHistoryEntry[] {
  const filePath = getHistoryFilePath(options?.historyPath)
  if (!existsSync(filePath)) return []

  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }

  const lines = raw.split(/\r?\n/)
  const parsed: PromptHistoryEntry[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as Partial<PromptHistoryEntry>
      if (typeof obj.display !== 'string' || !obj.display.trim()) continue
      if (options?.projectOnly && obj.project !== options.projectOnly) continue
      const prev = parsed[parsed.length - 1]
      if (prev && prev.display === obj.display) continue
      parsed.push({
        display: obj.display,
        pastedContents: obj.pastedContents,
        timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : 0,
        project: typeof obj.project === 'string' ? obj.project : undefined,
        sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
      })
      if (parsed.length >= (options?.limit ?? MAX_HISTORY_ENTRIES)) break
    } catch {
      // Skip malformed jsonl lines
    }
  }

  return parsed
}

/**
 * Reverse-incremental search (`Ctrl+R`) returning newest-first matches.
 */
export function searchHistory(
  query: string,
  entries: readonly PromptHistoryEntry[],
): PromptHistoryEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  const terms = q.split(/\s+/).filter(Boolean)
  return entries.filter(e => {
    const hay = e.display.toLowerCase()
    return terms.every(t => hay.includes(t))
  })
}
