/**
 * Hook matcher & AST-backed `if` permission-rule filter evaluation.
 */

import { splitCommand } from '../bash/commands.js'
import { expandCommandCandidates } from '../../tools/bash_tool/bash_command_helpers.js'
import { matchGitignorePathPattern } from '../permissions/filesystem.js'
import {
  isRuleToolNameMatch,
  normalizeLegacyToolName,
  permissionRuleValueFromString,
} from '../permissions/permission_rule_parser.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
} from '../permissions/shell_rule_matching.js'
import { resolvePsAlias } from '../powershell/dangerous_cmdlets.js'

/**
 * Tests whether a hook `matcher` string matches a target string (tool name,
 * notification type, session start source, file basename, etc.).
 * - Empty / undefined / `*` matches everything.
 * - Exact string, `|`-separated alternatives, or valid JavaScript RegExp.
 */
export function matchesHookMatcher(
  matcher: string | undefined,
  target: string | undefined,
): boolean {
  if (!matcher || matcher === '*' || matcher === '.*') {
    return true
  }
  if (!target) {
    return false
  }
  if (matcher === target) {
    return true
  }
  try {
    return new RegExp(`^(?:${matcher})$`).test(target)
  } catch {
    return matcher
      .split('|')
      .map(s => s.trim())
      .includes(target)
  }
}

/**
 * Evaluates a hook's optional `if` condition using permission-rule syntax
 * (e.g. `Bash(git push*)`, `Bash(npm test:*)`, `Edit(src/**)`, `PowerShell(Remove-Item:*)`).
 *
 * Uses AST-aware subcommand splitting & candidate expansion for Bash, canonical
 * alias resolution for PowerShell, and gitignore path matching for file tools.
 */
export function matchesHookIfCondition(
  ifCondition: string | undefined,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  if (!ifCondition || !ifCondition.trim()) {
    return true
  }
  if (!toolName) {
    return false
  }

  const parsedRule = permissionRuleValueFromString(ifCondition)
  if (!isRuleToolNameMatch(parsedRule.toolName, { name: toolName })) {
    return false
  }

  // Blanket tool condition like `Bash` or `Edit`
  if (parsedRule.ruleContent === undefined) {
    return true
  }

  const normTool = normalizeLegacyToolName(toolName)
  const content = parsedRule.ruleContent

  if (normTool === 'Bash') {
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : ''
    if (!command) return false
    const shellRule = parsePermissionRule(content)
    const parts = [command, ...splitCommand(command)]
    for (const part of parts) {
      for (const cand of expandCommandCandidates(part)) {
        if (shellRule.type === 'exact' && cand === shellRule.command) return true
        if (
          shellRule.type === 'prefix' &&
          (cand === shellRule.prefix || cand.startsWith(`${shellRule.prefix} `))
        ) {
          return true
        }
        if (
          shellRule.type === 'wildcard' &&
          matchWildcardPattern(shellRule.pattern, cand, false)
        ) {
          return true
        }
      }
    }
    return false
  }

  if (normTool === 'PowerShell') {
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : ''
    if (!command) return false
    const shellRule = parsePermissionRule(content)
    const firstTok = command.split(/\s+/)[0] ?? ''
    const canonical =
      resolvePsAlias(firstTok) + command.slice(firstTok.length).replace(/^\s+/, ' ')
    for (const cand of [command, canonical]) {
      if (shellRule.type === 'exact' && cand.toLowerCase() === shellRule.command.toLowerCase()) {
        return true
      }
      if (
        shellRule.type === 'prefix' &&
        (cand.toLowerCase() === shellRule.prefix.toLowerCase() ||
          cand.toLowerCase().startsWith(`${shellRule.prefix.toLowerCase()} `))
      ) {
        return true
      }
      if (
        shellRule.type === 'wildcard' &&
        matchWildcardPattern(shellRule.pattern, cand, true)
      ) {
        return true
      }
    }
    return false
  }

  // File / path tools (`Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep`)
  const pathArg =
    typeof toolInput?.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput?.notebook_path === 'string'
        ? toolInput.notebook_path
        : typeof toolInput?.path === 'string'
          ? toolInput.path
          : undefined

  if (pathArg) {
    return matchGitignorePathPattern(pathArg, content)
  }

  // WebFetch domain matching (`WebFetch(domain:example.com)`)
  if (normTool === 'WebFetch' && typeof toolInput?.url === 'string') {
    const domainMatch = content.match(/^domain:(.+)$/i)
    if (domainMatch?.[1]) {
      try {
        const host = new URL(toolInput.url).hostname.toLowerCase()
        const target = domainMatch[1].trim().toLowerCase()
        return host === target || host.endsWith(`.${target}`)
      } catch {
        return false
      }
    }
    return matchWildcardPattern(content, toolInput.url, true)
  }

  return false
}
