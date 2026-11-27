/**
 * Detection and stripping of overly broad shell/interpreter allow rules when
 * entering `auto` classifier mode, ensuring blanket rules like `Bash(*)` or
 * `Bash(python:*)` cannot silently bypass classifier scrutiny.
 */

import type {
  PermissionRuleSource,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
} from './permission_rule_parser.js'
import { parsePermissionRule } from './shell_rule_matching.js'

const DANGEROUS_BASH_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sudo',
  'doas',
  'pkexec',
  'su',
  'env',
  'xargs',
  'eval',
  'exec',
  'source',
  '.',
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'perl',
  'ruby',
  'php',
  'lua',
  'awk',
  'gawk',
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'rsync',
  'chmod',
  'chown',
  'rm',
  'dd',
  'mkfs',
  'nice',
  'nohup',
  'timeout',
  'stdbuf',
])

const DANGEROUS_POWERSHELL_PREFIXES = new Set([
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
  'bash',
  'sh',
  'invoke-webrequest',
  'iwr',
  'curl',
  'wget',
  'invoke-restmethod',
  'irm',
  'remove-item',
  'rm',
  'del',
  'ri',
  'rd',
  'erase',
  'python',
  'python3',
  'node',
  'bun',
])

function extractLeadingCommandToken(ruleContent: string): string | null {
  const parsed = parsePermissionRule(ruleContent)
  const raw =
    parsed.type === 'prefix'
      ? parsed.prefix
      : parsed.type === 'wildcard'
        ? parsed.pattern
        : parsed.command
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '*') {
    return '*'
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  return firstToken.replace(/\*+$/, '').toLowerCase()
}

export function isOverlyBroadBashAllowRule(ruleString: string): boolean {
  const parsed = permissionRuleValueFromString(ruleString)
  if (normalizeLegacyToolName(parsed.toolName) !== 'Bash') {
    return false
  }
  if (parsed.ruleContent === undefined) {
    return true
  }
  const trimmed = parsed.ruleContent.trim()
  if (trimmed === '*' || trimmed === ':*') {
    return true
  }
  const rule = parsePermissionRule(trimmed)
  if (rule.type === 'exact') {
    return false
  }
  const first = extractLeadingCommandToken(trimmed)
  if (first === '*') return true
  if (!first) return false
  // Single-word broad prefix like `python:*` or `bash *`
  const tokens = (rule.type === 'prefix' ? rule.prefix : rule.pattern)
    .trim()
    .split(/\s+/)
    .filter(t => t !== '*')
  return tokens.length <= 1 && DANGEROUS_BASH_PREFIXES.has(first)
}

export function isDangerousPowerShellPermission(ruleString: string): boolean {
  const parsed = permissionRuleValueFromString(ruleString)
  if (normalizeLegacyToolName(parsed.toolName) !== 'PowerShell') {
    return false
  }
  if (parsed.ruleContent === undefined) {
    return true
  }
  const trimmed = parsed.ruleContent.trim()
  if (trimmed === '*' || trimmed === ':*') {
    return true
  }
  const first = extractLeadingCommandToken(trimmed)
  return first === '*' || (first !== null && DANGEROUS_POWERSHELL_PREFIXES.has(first))
}

export function isOverlyBroadPowerShellAllowRule(ruleString: string): boolean {
  const parsed = permissionRuleValueFromString(ruleString)
  if (normalizeLegacyToolName(parsed.toolName) !== 'PowerShell') {
    return false
  }
  if (parsed.ruleContent === undefined) {
    return true
  }
  const rule = parsePermissionRule(parsed.ruleContent)
  if (rule.type === 'exact') {
    return false
  }
  return isDangerousPowerShellPermission(ruleString)
}

export function isDangerousAllowRuleForAutoMode(ruleString: string): boolean {
  const parsed = permissionRuleValueFromString(ruleString)
  const tool = normalizeLegacyToolName(parsed.toolName)
  if (tool === '*') return true
  if (tool === 'Bash') return isOverlyBroadBashAllowRule(ruleString)
  if (tool === 'PowerShell') return isOverlyBroadPowerShellAllowRule(ruleString)
  if (tool === 'Agent' && parsed.ruleContent === undefined) return true
  return false
}

/**
 * Strips overly broad shell/agent allow rules from `alwaysAllowRules` when
 * entering `auto` mode, preserving them in `strippedDangerousRules` so exiting
 * `auto` mode restores them cleanly.
 */
export function stripDangerousAllowRulesForAutoMode(
  context: DeepImmutable<ToolPermissionContext>,
): ToolPermissionContext {
  const nextAllow: ToolPermissionRulesBySource = {}
  const stripped: ToolPermissionRulesBySource = {
    ...(context.strippedDangerousRules
      ? Object.fromEntries(
          Object.entries(context.strippedDangerousRules).map(([k, v]) => [
            k,
            v ? [...v] : [],
          ]),
        )
      : {}),
  }

  for (const [sourceKey, rules] of Object.entries(context.alwaysAllowRules)) {
    const source = sourceKey as PermissionRuleSource
    if (!rules) continue
    const kept: string[] = []
    const removed: string[] = stripped[source] ? [...stripped[source]!] : []
    for (const rule of rules) {
      if (isDangerousAllowRuleForAutoMode(rule)) {
        if (!removed.includes(rule)) {
          removed.push(rule)
        }
      } else {
        kept.push(rule)
      }
    }
    if (kept.length > 0) {
      nextAllow[source] = kept
    }
    if (removed.length > 0) {
      stripped[source] = removed
    }
  }

  return {
    ...context,
    additionalWorkingDirectories: new Map(context.additionalWorkingDirectories),
    alwaysAllowRules: nextAllow,
    alwaysDenyRules: Object.fromEntries(
      Object.entries(context.alwaysDenyRules).map(([k, v]) => [
        k,
        v ? [...v] : [],
      ]),
    ),
    alwaysAskRules: Object.fromEntries(
      Object.entries(context.alwaysAskRules).map(([k, v]) => [
        k,
        v ? [...v] : [],
      ]),
    ),
    strippedDangerousRules:
      Object.keys(stripped).length > 0 ? stripped : undefined,
  }
}

/**
 * Restores previously stripped allow rules when leaving `auto` mode.
 */
export function restoreStrippedDangerousRules(
  context: DeepImmutable<ToolPermissionContext>,
): ToolPermissionContext {
  const nextAllow: ToolPermissionRulesBySource = Object.fromEntries(
    Object.entries(context.alwaysAllowRules).map(([k, v]) => [
      k,
      v ? [...v] : [],
    ]),
  )

  if (context.strippedDangerousRules) {
    for (const [sourceKey, rules] of Object.entries(
      context.strippedDangerousRules,
    )) {
      const source = sourceKey as PermissionRuleSource
      if (!rules?.length) continue
      const existing = nextAllow[source] ?? []
      const merged = [...existing]
      for (const rule of rules) {
        if (!merged.includes(rule)) {
          merged.push(rule)
        }
      }
      nextAllow[source] = merged
    }
  }

  return {
    ...context,
    additionalWorkingDirectories: new Map(context.additionalWorkingDirectories),
    alwaysAllowRules: nextAllow,
    alwaysDenyRules: Object.fromEntries(
      Object.entries(context.alwaysDenyRules).map(([k, v]) => [
        k,
        v ? [...v] : [],
      ]),
    ),
    alwaysAskRules: Object.fromEntries(
      Object.entries(context.alwaysAskRules).map(([k, v]) => [
        k,
        v ? [...v] : [],
      ]),
    ),
    strippedDangerousRules: undefined,
  }
}
