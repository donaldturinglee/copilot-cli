/**
 * Complete BashTool permission evaluator (`bashToolHasPermission`):
 * 1. Explicit `deny` rules (whole command + every subcommand + env/wrapper-stripped candidates)
 * 2. Sensitive-path & output-redirection `safetyCheck` (`checkPathConstraints`)
 * 3. `plan` mode restriction (`checkPermissionMode`)
 * 4. Explicit `ask` rules (whole command + per subcommand)
 * 5. Fail-closed AST + legacy security validation (`bashCommandIsSafeAsync`, `checkSedConstraints`)
 * 6. Sandboxed auto-allow (`SandboxManager.isAutoAllowBashIfSandboxedEnabled() && shouldUseSandbox()`)
 * 7. Explicit `allow` rules (whole command OR every subcommand matched cleanly)
 * 8. Granular AST-backed read-only allowlist (`isReadOnlyBashCommandAsync`)
 * 9. Default `ask` with reusable prefix/exact suggestions and destructive warnings
 */

import type { ToolUseContext } from '../../tool.js'
import type {
  PermissionResult,
  PermissionRule,
  PermissionUpdate,
} from '../../types/permissions.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { splitCommand } from '../../utilities/bash/commands.js'
import { permissionRuleValueToString } from '../../utilities/permissions/permission_rule_parser.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForToolName,
} from '../../utilities/permissions/permissions.js'
import {
  matchWildcardPattern as sharedMatchWildcardPattern,
  parsePermissionRule,
  permissionRuleExtractPrefix as sharedPermissionRuleExtractPrefix,
  type ShellPermissionRule,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
  suggestionForPrefix as sharedSuggestionForPrefix,
} from '../../utilities/permissions/shell_rule_matching.js'
import { SandboxManager } from '../../utilities/sandbox/sandbox_adapter.js'
import {
  BINARY_HIJACK_VARS,
  expandCommandCandidates,
  SAFE_ENV_VARS,
  stripLeadingEnvVars,
  stripSafeWrappers,
} from './bash_command_helpers.js'
import { bashCommandIsSafeAsync } from './bash_security.js'
import { getDestructiveCommandWarning } from './destructive_command_warning.js'
import { checkPermissionMode } from './mode_validation.js'
import { checkPathConstraints } from './path_validation.js'
import { isReadOnlyBashCommandAsync } from './read_only_validation.js'
import { checkSedConstraints } from './sed_validation.js'
import { shouldUseSandbox } from './should_use_sandbox.js'
import { BASH_TOOL_NAME } from './tool_name.js'

export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  'env',
  'xargs',
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  'sudo',
  'doas',
  'pkexec',
])

export const permissionRuleExtractPrefix = sharedPermissionRuleExtractPrefix

export function bashPermissionRule(ruleContent: string): ShellPermissionRule {
  return parsePermissionRule(ruleContent)
}

export function matchWildcardPattern(pattern: string, command: string): boolean {
  return sharedMatchWildcardPattern(pattern, command, false)
}

export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    if (!SAFE_ENV_VARS.has(varName)) return null
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) return null
  const first = remaining[0]!
  const subcmd = remaining[1]!
  if (BARE_SHELL_PREFIXES.has(first)) return null
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) return null
  return `${first} ${subcmd}`
}

function buildSuggestionsForCommand(command: string): PermissionUpdate[] {
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]?.trim()
    const prefix = firstLine ? getSimpleCommandPrefix(firstLine) : null
    if (prefix) {
      return sharedSuggestionForPrefix(BASH_TOOL_NAME, prefix)
    }
    return []
  }
  const prefix = getSimpleCommandPrefix(command)
  if (prefix) {
    return sharedSuggestionForPrefix(BASH_TOOL_NAME, prefix)
  }
  return sharedSuggestionForExactCommand(BASH_TOOL_NAME, command)
}

function matchesShellRule(
  rule: ShellPermissionRule,
  command: string,
): boolean {
  const trimmed = command.trim()
  switch (rule.type) {
    case 'exact':
      return trimmed === rule.command
    case 'prefix':
      return trimmed === rule.prefix || trimmed.startsWith(`${rule.prefix} `)
    case 'wildcard':
      return matchWildcardPattern(rule.pattern, trimmed)
  }
}

function findMatchingBashRule(
  command: string,
  rules: Map<string, PermissionRule>,
  expandForSafety: boolean,
): PermissionRule | undefined {
  const candidates = expandForSafety
    ? expandCommandCandidates(command)
    : [
        command.trim(),
        stripSafeWrappers(stripLeadingEnvVars(command, { onlySafe: true })),
      ]

  for (const [ruleContent, rule] of rules.entries()) {
    const parsed = bashPermissionRule(ruleContent)
    for (const cand of candidates) {
      if (matchesShellRule(parsed, cand)) {
        return rule
      }
    }
  }
  return undefined
}

export interface BashPermissionInput {
  command: string
  dangerouslyDisableSandbox?: boolean
  [key: string]: unknown
}

/**
 * Full permission & security evaluation for a `Bash` tool invocation.
 */
export async function bashToolHasPermission<Input extends BashPermissionInput>(
  input: Input,
  context: ToolUseContext,
): Promise<PermissionResult<Input>> {
  const permCtx =
    context.getAppState?.().toolPermissionContext ??
    getEmptyToolPermissionContext()

  const command = input.command.trim()
  const denyRules = getRuleByContentsForToolName(permCtx, BASH_TOOL_NAME, 'deny')
  const askRules = getRuleByContentsForToolName(permCtx, BASH_TOOL_NAME, 'ask')
  const allowRules = getRuleByContentsForToolName(
    permCtx,
    BASH_TOOL_NAME,
    'allow',
  )

  const subcommands = splitCommand(command)
  const checkList = subcommands.length > 0 ? [command, ...subcommands] : [command]

  // 1. Explicit `deny` rules ALWAYS win (whole command or any subcommand, expanded for safety)
  for (const part of checkList) {
    const denyMatch = findMatchingBashRule(part, denyRules, true)
    if (denyMatch) {
      return {
        behavior: 'deny',
        message: `Command denied by rule ${permissionRuleValueToString(denyMatch.ruleValue)}.`,
        decisionReason: { type: 'rule', rule: denyMatch },
      }
    }
  }

  // 2. Sensitive-path & redirection safety check (immune to bypassPermissions!)
  const pathCheck = checkPathConstraints(input, permCtx)
  if (pathCheck.behavior === 'ask' && pathCheck.decisionReason?.type === 'safetyCheck') {
    return pathCheck
  }

  // 3. Explicit `ask` rules (immune to bypassPermissions!)
  for (const part of checkList) {
    const askMatch = findMatchingBashRule(part, askRules, true)
    if (askMatch) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(
          BASH_TOOL_NAME,
          `matched ask rule ${permissionRuleValueToString(askMatch.ruleValue)}`,
        ),
        updatedInput: input,
        decisionReason: { type: 'rule', rule: askMatch },
        suggestions: buildSuggestionsForCommand(command),
      }
    }
  }

  // 4. Plan mode check (read-only commands allowed; writes denied)
  const modeResult = await checkPermissionMode(input, permCtx)
  if (modeResult.behavior === 'deny' || modeResult.behavior === 'allow') {
    return modeResult
  }

  // Guard against ReDoS/explosion on huge compound commands
  if (subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    return {
      behavior: 'ask',
      message: `Command contains too many subcommands (${subcommands.length}) for automatic approval`,
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'subcommand_limit_exceeded',
      },
    }
  }

  // 5. Sandboxed auto-allow (when OS sandbox is active and command will run inside it)
  if (
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Auto-allowed inside OS sandbox',
      },
    }
  }

  // 6. Fail-closed AST + legacy security check
  const securityResult = await bashCommandIsSafeAsync(command)
  if (securityResult.behavior === 'ask') {
    const warning = getDestructiveCommandWarning(command)
    const detail = warning
      ? `${securityResult.message} (${warning})`
      : securityResult.message
    return {
      behavior: 'ask',
      message: detail ?? `Command requires confirmation: ${command}`,
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: securityResult.message ?? 'bash_security_check',
      },
      isBashSecurityCheckForMisparsing: true,
      suggestions: buildSuggestionsForCommand(command),
    }
  }

  // Check sed-specific dangerous flags (`-f`, `e`, `w`, `r`)
  for (const sub of subcommands) {
    if (sub.trim().startsWith('sed ') || sub.trim() === 'sed') {
      const sedCheck = checkSedConstraints(sub)
      if (sedCheck.behavior === 'ask') {
        return {
          behavior: 'ask',
          message: sedCheck.message ?? `sed command requires confirmation: ${sub}`,
          updatedInput: input,
          decisionReason: {
            type: 'other',
            reason: sedCheck.message ?? 'sed_security_check',
          },
        }
      }
    }
  }

  // 7. Non-safetyCheck workingDir warning for redirections outside cwd
  if (pathCheck.behavior === 'ask') {
    return pathCheck
  }

  // 8. Explicit `allow` rules (whole command, OR every subcommand individually allowed/read-only)
  const wholeAllow = findMatchingBashRule(command, allowRules, false)
  if (wholeAllow) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: wholeAllow },
    }
  }

  if (subcommands.length > 0) {
    let allAllowedOrReadOnly = true
    let matchedRule: PermissionRule | undefined
    for (const sub of subcommands) {
      const subAllow = findMatchingBashRule(sub, allowRules, false)
      if (subAllow) {
        matchedRule = matchedRule ?? subAllow
        continue
      }
      const subReadOnly = await isReadOnlyBashCommandAsync(sub)
      if (!subReadOnly) {
        allAllowedOrReadOnly = false
        break
      }
    }
    if (allAllowedOrReadOnly) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: matchedRule
          ? { type: 'rule', rule: matchedRule }
          : { type: 'other', reason: 'Read-only Bash command' },
      }
    }
  }

  // 9. Granular read-only allowlist check
  if (await isReadOnlyBashCommandAsync(command)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'Read-only Bash command' },
    }
  }

  const destructiveWarning = getDestructiveCommandWarning(command)
  const message = destructiveWarning
    ? `Allow running command (${destructiveWarning}): ${command}`
    : `Allow running command: ${command}`

  return {
    behavior: 'ask',
    message,
    updatedInput: input,
    decisionReason: { type: 'mode', mode: permCtx.mode },
    suggestions: buildSuggestionsForCommand(command),
  }
}

export { BINARY_HIJACK_VARS, SAFE_ENV_VARS, stripLeadingEnvVars, stripSafeWrappers }
