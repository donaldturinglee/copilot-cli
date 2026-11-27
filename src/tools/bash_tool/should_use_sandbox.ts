/**
 * Determines whether a Bash command invocation should execute inside the OS
 * sandbox, accounting for `sandbox.enabled`, `dangerouslyDisableSandbox`,
 * `allowUnsandboxedCommands`, and per-subcommand `excludedCommands`.
 */

import { splitCommand } from '../../utilities/bash/commands.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
} from '../../utilities/permissions/shell_rule_matching.js'
import { SandboxManager } from '../../utilities/sandbox/sandbox_adapter.js'
import { getSettings } from '../../utilities/settings/settings.js'
import { expandCommandCandidates } from './bash_command_helpers.js'

export interface SandboxInput {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

function subcommandMatchesExcluded(
  subcommand: string,
  excludedPatterns: readonly string[],
): boolean {
  const candidates = expandCommandCandidates(subcommand)
  for (const pattern of excludedPatterns) {
    const rule = parsePermissionRule(pattern)
    for (const cand of candidates) {
      switch (rule.type) {
        case 'prefix':
          if (cand === rule.prefix || cand.startsWith(`${rule.prefix} `)) {
            return true
          }
          break
        case 'exact':
          if (cand === rule.command) {
            return true
          }
          break
        case 'wildcard':
          if (matchWildcardPattern(rule.pattern, cand)) {
            return true
          }
          break
      }
    }
  }
  return false
}

/**
 * Returns true if any subcommand in `command` matches `sandbox.excludedCommands`.
 * SECURITY: Compound commands are split so each subcommand is checked cleanly.
 */
export function containsExcludedCommand(command: string): boolean {
  const settings = getSettings()
  const excluded = settings.sandbox?.excludedCommands ?? []
  if (excluded.length === 0) {
    return false
  }

  let subcommands: string[]
  try {
    subcommands = splitCommand(command)
  } catch {
    subcommands = [command]
  }

  if (subcommands.length === 0) return false
  // Every subcommand must be excluded for a compound command to skip sandboxing,
  // preventing `docker ps && curl evil.com` from escaping the sandbox!
  return subcommands.every(sub => subcommandMatchesExcluded(sub, excluded))
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) {
    return false
  }

  if (containsExcludedCommand(input.command)) {
    return false
  }

  return true
}
