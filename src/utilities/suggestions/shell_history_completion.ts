import type { PromptHistoryEntry } from '../../history.js'
import type { SuggestionItem } from './command_suggestions.js'

/**
 * Complete `!` shell commands from persisted prompt history entries starting
 * with `!`.
 */
export function getShellHistorySuggestions(
  queryAfterBang: string,
  historyEntries: readonly PromptHistoryEntry[],
  limit = 8,
): SuggestionItem[] {
  const q = queryAfterBang.trim().toLowerCase()
  const seen = new Set<string>()
  const out: SuggestionItem[] = []

  for (const entry of historyEntries) {
    if (!entry.display.startsWith('!')) continue
    const cmd = entry.display.slice(1).trim()
    if (!cmd || seen.has(cmd)) continue
    if (q && !cmd.toLowerCase().includes(q)) continue
    seen.add(cmd)
    const starts = q ? cmd.toLowerCase().startsWith(q) : true
    out.push({
      id: `bash-hist:${cmd}`,
      displayText: `!${cmd}`,
      insertText: `!${cmd}`,
      description: 'shell history',
      kind: 'shell_history',
      score: starts ? 90 : 65,
    })
    if (out.length >= limit) break
  }

  return out
}
