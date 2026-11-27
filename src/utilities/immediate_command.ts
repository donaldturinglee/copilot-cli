import type { Command } from '../types/command.js'
import { parseSlashCommand } from './slash_command_parsing.js'

export const IMMEDIATE_COMMAND_NAMES = new Set([
  'btw',
  'help',
  'status',
  'cost',
  'context',
  'doctor',
  'theme',
  'vim',
  'version',
  'exit',
  'quit',
])

export function isImmediateCommand(
  input: string,
  commands?: readonly Command[],
): boolean {
  const parsed = parseSlashCommand(input)
  if (!parsed) return false
  const lower = parsed.commandName.toLowerCase()
  if (IMMEDIATE_COMMAND_NAMES.has(lower)) return true
  if (commands) {
    const cmd = commands.find(
      c =>
        c.name.toLowerCase() === lower ||
        c.aliases?.some(a => a.toLowerCase() === lower),
    )
    if (cmd?.immediate) return true
  }
  return false
}
