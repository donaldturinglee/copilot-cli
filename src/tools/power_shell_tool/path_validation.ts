/**
 * Path safety and bare-repo TOCTOU guard for `PowerShellTool`.
 */

import type { PermissionResult } from '../../types/permissions.js'
import { getCwd } from '../../utilities/cwd.js'
import { checkPathSafetyForAutoEdit } from '../../utilities/permissions/filesystem.js'
import { resolvePsAlias } from '../../utilities/powershell/dangerous_cmdlets.js'
import {
  getAllCommands,
  getFileRedirections,
  type ParsedPowerShellCommand,
} from '../../utilities/powershell/parser.js'
import { isDotGitPathPs, isGitInternalPathPs } from './git_safety.js'

const PS_WRITE_CMDLETS = new Set([
  'new-item',
  'set-content',
  'add-content',
  'clear-content',
  'out-file',
  'copy-item',
  'move-item',
  'rename-item',
  'remove-item',
  'expand-archive',
  'tee-object',
  'export-csv',
  'export-clixml',
  'invoke-webrequest',
  'invoke-restmethod',
])

const ARCHIVE_EXTRACTORS = new Set([
  'tar',
  'tar.exe',
  'bsdtar',
  'bsdtar.exe',
  'unzip',
  'unzip.exe',
  '7z',
  '7z.exe',
  '7za',
  '7za.exe',
  'expand-archive',
])

export function checkPowerShellPathConstraints<
  Input extends { command: string },
>(input: Input, parsed: ParsedPowerShellCommand): PermissionResult<Input> {
  const cwd = getCwd()
  const commands = getAllCommands(parsed)
  const hasGitCommand = commands.some(cmd => {
    const c = resolvePsAlias(cmd.name)
    return c === 'git' || c === 'git.exe'
  })

  // 1. Check archive extraction + git bare-repo TOCTOU
  if (hasGitCommand) {
    for (const cmd of commands) {
      const canonical = resolvePsAlias(cmd.name)
      if (ARCHIVE_EXTRACTORS.has(canonical)) {
        const msg = `Archive extraction ('${cmd.name}') combined with 'git' poses bare-repository TOCTOU risk`
        return {
          behavior: 'ask',
          message: msg,
          updatedInput: input,
          decisionReason: {
            type: 'safetyCheck',
            reason: msg,
            classifierApprovable: false,
          },
        }
      }
    }
  }

  // 2. Check file redirection targets
  for (const redir of getFileRedirections(parsed)) {
    const loc = redir.location.trim()
    if (!loc || loc.toLowerCase() === '$null') continue

    if (
      isDotGitPathPs(loc, cwd) ||
      (hasGitCommand && isGitInternalPathPs(loc, cwd))
    ) {
      const msg = `PowerShell redirection targets protected git path '${loc}'`
      return {
        behavior: 'ask',
        message: msg,
        updatedInput: input,
        blockedPath: loc,
        decisionReason: {
          type: 'safetyCheck',
          reason: msg,
          classifierApprovable: false,
        },
      }
    }

    const safety = checkPathSafetyForAutoEdit(loc)
    if (!safety.safe) {
      const msg = safety.message ?? `PowerShell redirection targets sensitive path '${loc}'`
      return {
        behavior: 'ask',
        message: msg,
        updatedInput: input,
        blockedPath: loc,
        decisionReason: {
          type: 'safetyCheck',
          reason: msg,
          classifierApprovable: false,
        },
      }
    }
  }

  // 3. Check write-cmdlet argument paths
  for (const cmd of commands) {
    const canonical = resolvePsAlias(cmd.name)
    if (!PS_WRITE_CMDLETS.has(canonical)) continue

    for (const arg of cmd.args) {
      if (!arg || arg.startsWith('-')) continue

      if (
        isDotGitPathPs(arg, cwd) ||
        (hasGitCommand && isGitInternalPathPs(arg, cwd))
      ) {
        const msg = `PowerShell command '${cmd.name}' writes to protected git/bare-repo path '${arg}'`
        return {
          behavior: 'ask',
          message: msg,
          updatedInput: input,
          blockedPath: arg,
          decisionReason: {
            type: 'safetyCheck',
            reason: msg,
            classifierApprovable: false,
          },
        }
      }

      const safety = checkPathSafetyForAutoEdit(arg)
      if (!safety.safe) {
        const msg =
          safety.message ??
          `PowerShell command '${cmd.name}' targets sensitive path '${arg}'`
        return {
          behavior: 'ask',
          message: msg,
          updatedInput: input,
          blockedPath: arg,
          decisionReason: {
            type: 'safetyCheck',
            reason: msg,
            classifierApprovable: false,
          },
        }
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: 'PowerShell path constraints passed',
  }
}
