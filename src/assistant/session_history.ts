/**
 * Lightweight assistant-mode session history reader/formatter over saved
 * project session logs.
 */

import type { LogOption } from '../types/logs.js'

export interface AssistantSessionSummary {
  sessionId: string
  title: string
  modifiedIso: string
  messageCount: number
  gitBranch?: string
}

/**
 * Formats a list of `LogOption` entries into concise assistant session history
 * summaries sorted newest-first.
 */
export function formatAssistantSessionHistory(
  logs: readonly LogOption[],
  limit = 20,
): AssistantSessionSummary[] {
  return [...logs]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, Math.max(0, limit))
    .map(log => ({
      sessionId: log.sessionId ?? '',
      title: log.customTitle ?? log.summary ?? log.firstPrompt ?? '(session)',
      modifiedIso: log.modified.toISOString(),
      messageCount: log.messageCount,
      ...(log.gitBranch ? { gitBranch: log.gitBranch } : {}),
    }))
}
