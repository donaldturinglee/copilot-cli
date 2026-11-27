/**
 * Granular read-only PowerShell cmdlet allowlist validation.
 */

import { isCurrentDirectoryBareGitRepo } from '../../utilities/git.js'
import { resolvePsAlias } from '../../utilities/powershell/dangerous_cmdlets.js'
import {
  getAllCommands,
  type ParsedCommandElement,
  type ParsedPowerShellCommand,
  parsePowerShellCommand,
} from '../../utilities/powershell/parser.js'
import { powershellCommandIsSafe } from './powershell_security.js'

const READ_ONLY_PS_CMDLETS = new Set([
  'get-childitem',
  'get-content',
  'get-location',
  'get-item',
  'get-itemproperty',
  'get-date',
  'get-host',
  'get-process',
  'get-command',
  'get-help',
  'get-module',
  'test-path',
  'resolve-path',
  'split-path',
  'join-path',
  'select-string',
  'measure-object',
  'sort-object',
  'select-object',
  'format-table',
  'format-list',
  'format-wide',
  'write-output',
  'out-string',
  'convertto-json',
  'convertfrom-json',
  'hostname',
  'whoami',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'describe',
  'ls-files',
  'blame',
  'shortlog',
  'show-ref',
])

const DANGEROUS_GIT_FLAGS = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--ext-diff',
  '--textconv',
])

export function resolveToCanonical(commandName: string): string {
  return resolvePsAlias(commandName)
}

function isSafeGitCmd(cmd: ParsedCommandElement): boolean {
  if (isCurrentDirectoryBareGitRepo()) return false
  let i = 0
  while (i < cmd.args.length) {
    const a = cmd.args[i]!
    if (a === '-C') {
      i += 2
      continue
    }
    if (a === '--no-pager' || a === '--no-optional-locks') {
      i++
      continue
    }
    if (
      DANGEROUS_GIT_FLAGS.has(a) ||
      a.startsWith('-c') ||
      a.startsWith('--git-dir=') ||
      a.startsWith('--work-tree=')
    ) {
      return false
    }
    if (a.startsWith('-')) return false
    break
  }
  const sub = cmd.args[i]
  return sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub)
}

export function isReadOnlyParsedPowerShellCommand(
  parsed: ParsedPowerShellCommand,
): boolean {
  const sec = powershellCommandIsSafe(parsed)
  if (sec.behavior !== 'passthrough') {
    return false
  }

  const cmds = getAllCommands(parsed)
  if (cmds.length === 0) return false

  for (const cmd of cmds) {
    const canonical = resolveToCanonical(cmd.name)
    if (canonical === 'git' || canonical === 'git.exe') {
      if (!isSafeGitCmd(cmd)) return false
      continue
    }
    if (!READ_ONLY_PS_CMDLETS.has(canonical)) {
      return false
    }
  }

  return true
}

export async function isReadOnlyPowerShellCommand(
  command: string,
): Promise<boolean> {
  const parsed = await parsePowerShellCommand(command)
  return isReadOnlyParsedPowerShellCommand(parsed)
}
