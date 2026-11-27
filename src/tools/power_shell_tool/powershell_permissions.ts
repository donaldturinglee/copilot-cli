/**
 * Full PowerShell permission evaluator (`powershellToolHasPermission`):
 * - Case-insensitive AND canonical-alias rule matching (so a deny rule for
 *   `PowerShell(Remove-Item:*)` blocks `rm foo.txt` and `PowerShell(Invoke-Expression:*)`
 *   blocks `iex ...`, including module-qualified forms!)
 * - Fail-closed native PowerShell AST parsing (`parsePowerShellCommand`)
 * - Sensitive-path & bare-repo TOCTOU `safetyCheck` (immune to `bypassPermissions`)
 * - CLM `.NET` type allowlist & UNC path exfiltration guard (`powershellCommandIsSafe`)
 * - `plan` mode guard & read-only cmdlet allowlist
 */

import type { ToolUseContext } from '../../tool.js'
import type {
  PermissionResult,
  PermissionRule,
  PermissionUpdate,
} from '../../types/permissions.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { permissionRuleValueToString } from '../../utilities/permissions/permission_rule_parser.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForToolName,
} from '../../utilities/permissions/permissions.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
  type ShellPermissionRule,
  suggestionForExactCommand,
  suggestionForPrefix,
} from '../../utilities/permissions/shell_rule_matching.js'
import {
  resolvePsAlias,
  stripModulePrefix,
} from '../../utilities/powershell/dangerous_cmdlets.js'
import {
  getAllCommands,
  parsePowerShellCommand,
} from '../../utilities/powershell/parser.js'
import { getPowerShellCommandPrefix } from '../../utilities/powershell/static_prefix.js'
import { getPowerShellDestructiveWarning } from './destructive_command_warning.js'
import { checkPowerShellPermissionMode } from './mode_validation.js'
import { checkPowerShellPathConstraints } from './path_validation.js'
import { powershellCommandIsSafe } from './powershell_security.js'
import { isReadOnlyParsedPowerShellCommand } from './read_only_validation.js'
import { POWERSHELL_TOOL_NAME } from './tool_name.js'

export interface PowerShellPermissionInput {
  command: string
  timeout?: number
  [key: string]: unknown
}

function buildCanonicalForm(command: string): string {
  const trimmed = command.trim()
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  const canonical = resolvePsAlias(firstToken)
  const rest = trimmed.slice(firstToken.length).replace(/^\s+/, ' ')
  return canonical + rest
}

function matchesPsRule(
  rule: ShellPermissionRule,
  candidate: string,
  behavior: 'deny' | 'ask' | 'allow',
): boolean {
  const lowerCand = candidate.trim().toLowerCase()
  const matchSingle = (patternRule: ShellPermissionRule, cmd: string): boolean => {
    switch (patternRule.type) {
      case 'exact':
        return cmd === patternRule.command.toLowerCase()
      case 'prefix': {
        const pref = patternRule.prefix.toLowerCase()
        return cmd === pref || cmd.startsWith(`${pref} `)
      }
      case 'wildcard':
        return matchWildcardPattern(patternRule.pattern, cmd, true)
    }
  }

  if (matchSingle(rule, lowerCand)) {
    return true
  }

  // Cross-match canonical alias forms (e.g. rule `Remove-Item:*` matches `rm foo.txt`,
  // and for deny/ask, rule `rm:*` also matches `Remove-Item foo.txt`!)
  const canonicalCand = buildCanonicalForm(candidate)
  if (matchSingle(rule, canonicalCand)) {
    return true
  }

  if (behavior !== 'allow') {
    const rawRuleText =
      rule.type === 'exact'
        ? rule.command
        : rule.type === 'prefix'
          ? rule.prefix
          : rule.pattern
    const firstRuleTok = rawRuleText.trim().split(/\s+/)[0] ?? ''
    const canonicalRuleHead = resolvePsAlias(stripModulePrefix(firstRuleTok))
    const ruleRest = rawRuleText.slice(firstRuleTok.length).replace(/^\s+/, ' ')
    const canonicalRuleText = canonicalRuleHead + ruleRest
    const rewrittenRule: ShellPermissionRule =
      rule.type === 'exact'
        ? { type: 'exact', command: canonicalRuleText }
        : rule.type === 'prefix'
          ? { type: 'prefix', prefix: canonicalRuleText }
          : { type: 'wildcard', pattern: canonicalRuleText }

    if (matchSingle(rewrittenRule, canonicalCand)) {
      return true
    }
  }

  return false
}

function findMatchingPsRule(
  candidates: readonly string[],
  rules: Map<string, PermissionRule>,
  behavior: 'deny' | 'ask' | 'allow',
): PermissionRule | undefined {
  for (const [ruleContent, rule] of rules.entries()) {
    const parsed = parsePermissionRule(ruleContent)
    for (const cand of candidates) {
      if (matchesPsRule(parsed, cand, behavior)) {
        return rule
      }
    }
  }
  return undefined
}

function buildSuggestions(command: string): PermissionUpdate[] {
  const prefix = getPowerShellCommandPrefix(command)
  if (prefix) {
    return suggestionForPrefix(POWERSHELL_TOOL_NAME, prefix)
  }
  if (command.includes('\n') || command.includes('*')) {
    return []
  }
  return suggestionForExactCommand(POWERSHELL_TOOL_NAME, command)
}

export async function powershellToolHasPermission<
  Input extends PowerShellPermissionInput,
>(input: Input, context: ToolUseContext): Promise<PermissionResult<Input>> {
  const permCtx =
    context.getAppState?.().toolPermissionContext ??
    getEmptyToolPermissionContext()

  const command = input.command.trim()
  const parsed = await parsePowerShellCommand(command)

  const cmdTexts = [
    command,
    ...getAllCommands(parsed).map(c => c.text.trim()).filter(Boolean),
  ]

  const denyRules = getRuleByContentsForToolName(
    permCtx,
    POWERSHELL_TOOL_NAME,
    'deny',
  )
  const askRules = getRuleByContentsForToolName(
    permCtx,
    POWERSHELL_TOOL_NAME,
    'ask',
  )
  const allowRules = getRuleByContentsForToolName(
    permCtx,
    POWERSHELL_TOOL_NAME,
    'allow',
  )

  // 1. Explicit `deny` rules ALWAYS win (canonical alias aware!)
  const denyMatch = findMatchingPsRule(cmdTexts, denyRules, 'deny')
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `PowerShell command denied by rule ${permissionRuleValueToString(denyMatch.ruleValue)}.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }

  // 2. Sensitive-path & bare-repo TOCTOU `safetyCheck` (immune to bypassPermissions!)
  const pathCheck = checkPowerShellPathConstraints(input, parsed)
  if (pathCheck.behavior === 'ask' && pathCheck.decisionReason?.type === 'safetyCheck') {
    return pathCheck
  }

  // 3. Explicit `ask` rules (immune to bypassPermissions!)
  const askMatch = findMatchingPsRule(cmdTexts, askRules, 'ask')
  if (askMatch) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        `matched ask rule ${permissionRuleValueToString(askMatch.ruleValue)}`,
      ),
      updatedInput: input,
      decisionReason: { type: 'rule', rule: askMatch },
      suggestions: buildSuggestions(command),
    }
  }

  // 4. Plan mode check
  const modeResult = checkPowerShellPermissionMode(input, parsed, permCtx)
  if (modeResult.behavior === 'deny' || modeResult.behavior === 'allow') {
    return modeResult
  }

  // 5. Fail-closed PowerShell AST security check
  const secResult = powershellCommandIsSafe(parsed)
  if (secResult.behavior === 'ask') {
    const warning = getPowerShellDestructiveWarning(command)
    const msg = warning
      ? `${secResult.message} (${warning})`
      : secResult.message ?? `PowerShell command requires confirmation: ${command}`
    return {
      behavior: 'ask',
      message: msg,
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: secResult.message ?? 'powershell_security_check',
      },
      suggestions: buildSuggestions(command),
    }
  }

  // 6. Explicit `allow` rules
  const allowMatch = findMatchingPsRule([command], allowRules, 'allow')
  if (allowMatch) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: allowMatch },
    }
  }

  // 7. Granular read-only cmdlet allowlist
  if (isReadOnlyParsedPowerShellCommand(parsed)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'Read-only PowerShell command' },
    }
  }

  const warning = getPowerShellDestructiveWarning(command)
  return {
    behavior: 'ask',
    message: warning
      ? `Allow running PowerShell command (${warning}): ${command}`
      : `Allow running PowerShell command: ${command}`,
    updatedInput: input,
    decisionReason: { type: 'mode', mode: permCtx.mode },
    suggestions: buildSuggestions(command),
  }
}
