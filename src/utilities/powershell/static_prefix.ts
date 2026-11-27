/**
 * Static prefix extraction for PowerShell permission rule suggestions.
 */

import { stripModulePrefix } from './dangerous_cmdlets.js'

const DANGEROUS_PS_PREFIX_SUGGESTIONS = new Set([
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
  'start-process',
  'saps',
  'start',
  'pwsh',
  'pwsh.exe',
  'powershell',
  'powershell.exe',
  'cmd',
  'cmd.exe',
  'remove-item',
  'rm',
  'del',
])

export function getPowerShellCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const first = stripModulePrefix(tokens[0]!)
  const firstLower = first.toLowerCase()
  if (DANGEROUS_PS_PREFIX_SUGGESTIONS.has(firstLower)) {
    return null
  }
  if (tokens.length >= 2 && /^[a-z][a-z0-9-]*$/i.test(tokens[1]!)) {
    return `${first} ${tokens[1]}`
  }
  if (/^[a-z][a-z0-9-]*$/i.test(first)) {
    return first
  }
  return null
}
