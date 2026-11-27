/**
 * Path-constraint & sensitive-file safety checks for Bash commands.
 * Inspects output redirections (`>`, `>>`, `>|`, `&>`) and file-mutating
 * commands (`rm`, `mv`, `cp`, `touch`, `tee`, `chmod`, `chown`, `ln`, `sed -i`,
 * `truncate`, `dd`) against `checkPathSafetyForAutoEdit()` (`.git`, `.copilot`,
 * `.gitconfig`, shell rc files, Windows path tricks) so Bash commands CANNOT
 * sneak past `safetyCheck` even under `bypassPermissions`!
 */

import type {
  PermissionResult,
  ToolPermissionContext,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { extractOutputRedirections, splitCommand } from '../../utilities/bash/commands.js'
import { tryParseShellCommand } from '../../utilities/bash/shell_quote.js'
import {
  checkPathSafetyForAutoEdit,
  pathInAllowedWorkingPath,
} from '../../utilities/permissions/filesystem.js'

const FILE_MUTATING_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'mkdir',
  'rmdir',
  'touch',
  'chmod',
  'chown',
  'chgrp',
  'ln',
  'tee',
  'truncate',
  'install',
  'dd',
])

function extractCandidateWritePaths(command: string): string[] {
  const paths: string[] = []
  const { redirections } = extractOutputRedirections(command)
  for (const r of redirections) {
    paths.push(r.target)
  }

  for (const sub of splitCommand(command)) {
    const tokenized = tryParseShellCommand(sub)
    if (!tokenized.success) continue
    const tokens = tokenized.tokens.filter((t): t is string => typeof t === 'string')
    if (tokens.length === 0) continue

    let idx = 0
    while (idx < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[idx]!)) {
      idx++
    }
    const bin = (tokens[idx] ?? '').split('/').pop() ?? ''
    const args = tokens.slice(idx + 1)

    if (bin === 'dd') {
      for (const a of args) {
        if (a.startsWith('of=')) {
          paths.push(a.slice(3))
        }
      }
      continue
    }

    if (bin === 'sed' && args.some(a => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place'))) {
      for (const a of args) {
        if (!a.startsWith('-')) {
          paths.push(a)
        }
      }
      continue
    }

    if (FILE_MUTATING_COMMANDS.has(bin)) {
      for (const a of args) {
        if (!a.startsWith('-')) {
          paths.push(a)
        }
      }
    }
  }

  return paths
}

/**
 * Checks Bash command output targets and mutation paths against sensitive-path
 * protection (`safetyCheck`) and working-directory constraints.
 */
export function checkPathConstraints<Input extends { command: string }>(
  input: Input,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): PermissionResult<Input> {
  const targetPaths = extractCandidateWritePaths(input.command)

  for (const targetPath of targetPaths) {
    const safety = checkPathSafetyForAutoEdit(targetPath)
    if (!safety.safe) {
      const reason =
        safety.message ??
        `Bash command targets sensitive path '${targetPath}'`
      return {
        behavior: 'ask',
        message: reason,
        updatedInput: input,
        blockedPath: targetPath,
        decisionReason: {
          type: 'safetyCheck',
          reason,
          classifierApprovable: safety.classifierApprovable,
        },
      }
    }
  }

  // Flag redirections outside allowed working directories when not in bypass mode
  const { redirections } = extractOutputRedirections(input.command)
  for (const redir of redirections) {
    if (!pathInAllowedWorkingPath(redir.target, permissionContext)) {
      return {
        behavior: 'ask',
        message: `Bash command redirects output outside the working directory to '${redir.target}'`,
        updatedInput: input,
        blockedPath: redir.target,
        decisionReason: {
          type: 'workingDir',
          reason: `Output redirection target '${redir.target}' is outside allowed directories`,
        },
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Path constraints passed',
  }
}
