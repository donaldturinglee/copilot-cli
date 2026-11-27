/**
 * Shared shell command rule parsing and wildcard matching for `Bash` and `PowerShell`.
 * Supports:
 * - Legacy `prefix:*` syntax (matches exact prefix or `prefix <args>`)
 * - Wildcard patterns with `*` (word-boundary aware for trailing ` *`)
 * - Escaped literal `\*`
 * - Exact command matching
 */

import type { PermissionUpdate } from '../../types/permissions.js'
import { permissionRuleExtractPrefix } from './permission_rule_parser.js'

export type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

function hasUnescapedWildcard(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++
      continue
    }
    if (pattern[i] === '*') {
      return true
    }
  }
  return false
}

/**
 * Parses a shell permission rule's content into exact, legacy prefix (`:*`), or
 * wildcard rule form.
 */
export function parsePermissionRule(ruleContent: string): ShellPermissionRule {
  const trimmed = ruleContent.trim()
  const prefix = permissionRuleExtractPrefix(trimmed)
  if (prefix !== null) {
    return { type: 'prefix', prefix }
  }
  if (hasUnescapedWildcard(trimmed)) {
    return { type: 'wildcard', pattern: trimmed }
  }
  return { type: 'exact', command: trimmed }
}

/**
 * Matches a shell command string against a wildcard pattern where unescaped `*`
 * matches any characters (including newlines), and a trailing ` *` makes the
 * space + arguments optional (so `git status *` matches both `git status` and
 * `git status -s`).
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  const trimmedPattern = pattern.trim()
  const trimmedCommand = command.trim()

  if (trimmedPattern === '*') {
    return true
  }

  // Handle trailing ` *` (unescaped) so `cmd *` matches both `cmd` and `cmd arg`
  const hasOptionalTrailingArgs =
    trimmedPattern.endsWith(' *') && !trimmedPattern.endsWith('\\*')

  const corePattern = hasOptionalTrailingArgs
    ? trimmedPattern.slice(0, -2)
    : trimmedPattern

  let regexSource = '^'
  for (let i = 0; i < corePattern.length; i++) {
    const ch = corePattern[i]!
    if (ch === '\\' && i + 1 < corePattern.length && corePattern[i + 1] === '*') {
      regexSource += '\\*'
      i++
      continue
    }
    if (ch === '*') {
      regexSource += '[\\s\\S]*'
      continue
    }
    regexSource += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }

  if (hasOptionalTrailingArgs) {
    regexSource += '(?:\\s+[\\s\\S]*)?$'
  } else {
    regexSource += '$'
  }

  const flags = caseInsensitive ? 'i' : ''
  return new RegExp(regexSource, flags).test(trimmedCommand)
}

export function suggestionForExactCommand(
  toolName: string,
  command: string,
): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      rules: [{ toolName, ruleContent: command }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]
}

export function suggestionForPrefix(
  toolName: string,
  prefix: string,
): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      rules: [{ toolName, ruleContent: `${prefix}:*` }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]
}

export { permissionRuleExtractPrefix }
