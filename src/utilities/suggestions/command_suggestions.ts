import type { Command } from '../../types/command.js'
import { getCommandName, isCommandEnabled } from '../../types/command.js'
import { getSkillUsageBoost } from './skill_usage_tracking.js'

export type SuggestionItem = {
  id: string
  displayText: string
  insertText: string
  description?: string
  kind:
    | 'command'
    | 'command_arg'
    | 'file'
    | 'directory'
    | 'shell_history'
    | 'member'
    | 'mcp'
    | 'agent'
    | 'context'
  score: number
}

function fuzzyScore(needle: string, haystack: string): number {
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  if (!n) return 10
  if (h === n) return 100
  if (h.startsWith(n)) return 80 - (h.length - n.length) * 0.2
  const idx = h.indexOf(n)
  if (idx !== -1) return 55 - idx * 0.5

  let pos = 0
  let consecutive = 0
  let score = 0
  for (let i = 0; i < n.length; i++) {
    const found = h.indexOf(n[i]!, pos)
    if (found === -1) return -1
    if (found === pos) consecutive++
    else consecutive = 0
    score += 4 + consecutive * 2
    pos = found + 1
  }
  return score
}

export function getCommandSuggestions(
  query: string,
  commands: readonly Command[],
  limit = 10,
): SuggestionItem[] {
  const clean = query.startsWith('/') ? query.slice(1) : query
  const scored: SuggestionItem[] = []

  for (const cmd of commands) {
    if (cmd.isHidden || !isCommandEnabled(cmd)) continue
    if (cmd.userInvocable === false) continue
    const displayName = getCommandName(cmd)
    const names = [displayName, ...(cmd.aliases ?? [])]
    let best = -1
    for (const candidate of names) {
      const s = fuzzyScore(clean, candidate)
      if (s > best) best = s
    }
    if (best < 0) continue
    const boost = getSkillUsageBoost(displayName)
    scored.push({
      id: `cmd:${displayName}`,
      displayText: `/${displayName}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`,
      insertText: `/${displayName} `,
      description: cmd.description,
      kind: 'command',
      score: best + boost,
    })
  }

  scored.sort((a, b) => b.score - a.score || a.displayText.localeCompare(b.displayText))
  return scored.slice(0, limit)
}

const KNOWN_ARG_COMPLETIONS: Record<string, readonly { value: string; description: string }[]> = {
  effort: [
    { value: 'low', description: 'Faster responses with minimal reasoning' },
    { value: 'medium', description: 'Balanced reasoning depth' },
    { value: 'high', description: 'Deep reasoning for complex problems' },
    { value: 'max', description: 'Maximum thinking budget' },
  ],
  theme: [
    { value: 'dark', description: 'Default dark theme' },
    { value: 'light', description: 'Light terminal theme' },
    { value: 'dark-daltonized', description: 'Colorblind-safe dark theme' },
    { value: 'light-daltonized', description: 'Colorblind-safe light theme' },
    { value: 'dark-ansi', description: '16-color ANSI dark theme' },
    { value: 'light-ansi', description: '16-color ANSI light theme' },
  ],
  'output-style': [
    { value: 'default', description: 'Concise engineering assistant style' },
    { value: 'explanatory', description: 'Detailed architecture & rationale explanations' },
    { value: 'learning', description: 'Collaborative guided learning style' },
  ],
  fast: [
    { value: 'on', description: 'Enable fast mode' },
    { value: 'off', description: 'Disable fast mode' },
  ],
  vim: [
    { value: 'on', description: 'Enable Vim editing mode' },
    { value: 'off', description: 'Return to standard Emacs/readline editing' },
  ],
}

export function getCommandArgSuggestions(
  commandName: string,
  argPrefix: string,
  limit = 8,
): SuggestionItem[] {
  const candidates = KNOWN_ARG_COMPLETIONS[commandName.toLowerCase()]
  if (!candidates) return []
  const q = argPrefix.trim().toLowerCase()
  const out: SuggestionItem[] = []
  for (const c of candidates) {
    const score = fuzzyScore(q, c.value)
    if (score < 0) continue
    out.push({
      id: `arg:${commandName}:${c.value}`,
      displayText: c.value,
      insertText: `/${commandName} ${c.value}`,
      description: c.description,
      kind: 'command_arg',
      score,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}
