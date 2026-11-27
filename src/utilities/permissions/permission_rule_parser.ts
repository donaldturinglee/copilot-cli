/**
 * Canonical permission rule parser (`Tool`, `Tool(content)`, legacy aliases,
 * MCP server prefixes, and legacy `:*` prefix extraction).
 */

import type { PermissionRuleValue } from '../../types/permissions.js'

const LEGACY_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  Task: 'Agent',
  FileRead: 'Read',
  FileEdit: 'Edit',
  FileWrite: 'Write',
  NotebookRead: 'Read',
}

const CANONICAL_TO_LEGACY_NAMES: Readonly<Record<string, readonly string[]>> = {
  Agent: ['Task'],
  Read: ['FileRead', 'NotebookRead'],
  Edit: ['FileEdit'],
  Write: ['FileWrite'],
}

/**
 * Normalizes historical tool aliases to their canonical names.
 */
export function normalizeLegacyToolName(toolName: string): string {
  return LEGACY_TOOL_NAME_MAP[toolName] ?? toolName
}

/**
 * Returns legacy alias names for a canonical tool name, if any.
 */
export function getLegacyToolNames(canonicalToolName: string): readonly string[] {
  return CANONICAL_TO_LEGACY_NAMES[canonicalToolName] ?? []
}

function unescapeRuleContent(raw: string): string {
  let result = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!
      if (next === '(' || next === ')' || next === '\\') {
        result += next
        i++
        continue
      }
    }
    result += ch
  }
  return result
}

function escapeRuleContent(content: string): string {
  return content.replace(/([()\\])/g, '\\$1')
}

/**
 * Parses a permission rule string such as `Read`, `Bash(git status)`,
 * `Edit(src/**)`, or `mcp__github__list_issues` into a `PermissionRuleValue`.
 */
export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  const trimmed = ruleString.trim()
  let openIdx = -1
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\') {
      i++
      continue
    }
    if (trimmed[i] === '(') {
      openIdx = i
      break
    }
  }

  if (openIdx === -1 || !trimmed.endsWith(')')) {
    return {
      toolName: normalizeLegacyToolName(trimmed),
    }
  }

  const rawToolName = trimmed.slice(0, openIdx).trim()
  const rawContent = trimmed.slice(openIdx + 1, -1)
  const toolName = normalizeLegacyToolName(rawToolName)

  if (rawContent.length === 0) {
    return { toolName }
  }

  // Wildcard-only `Tool(*)` behaves identically to blanket `Tool` for non-shell
  // rules, while shell tools preserve `*` when explicitly matching content.
  const unescaped = unescapeRuleContent(rawContent)
  if (unescaped === '*' && toolName !== 'Bash' && toolName !== 'PowerShell') {
    return { toolName }
  }

  return {
    toolName,
    ruleContent: unescaped,
  }
}

/**
 * Serializes a `PermissionRuleValue` back to `Tool` or `Tool(content)`.
 */
export function permissionRuleValueToString(
  ruleValue: PermissionRuleValue,
): string {
  const toolName = normalizeLegacyToolName(ruleValue.toolName)
  if (ruleValue.ruleContent === undefined) {
    return toolName
  }
  // Preserve unescaped shell/path patterns when no embedded parens exist
  if (!/[()]/.test(ruleValue.ruleContent)) {
    return `${toolName}(${ruleValue.ruleContent})`
  }
  return `${toolName}(${escapeRuleContent(ruleValue.ruleContent)})`
}

/**
 * Extracts the prefix from legacy `prefix:*` syntax (e.g. `git commit:*` -> `git commit`).
 * Returns `null` if the rule content is not in `:*` prefix format.
 */
export function permissionRuleExtractPrefix(
  ruleContent: string,
): string | null {
  const trimmed = ruleContent.trim()
  if (!trimmed.endsWith(':*')) {
    return null
  }
  const prefix = trimmed.slice(0, -2)
  if (!prefix || prefix.endsWith('\\')) {
    return null
  }
  return prefix
}

/**
 * Parses an MCP tool or server rule name (`mcp__server`, `mcp__server__*`, `mcp__server__tool`).
 */
export function parseMcpRuleName(name: string): {
  serverName: string
  toolName?: string
  isWildcard: boolean
} | null {
  if (!name.startsWith('mcp__')) {
    return null
  }
  const rest = name.slice('mcp__'.length)
  if (!rest) return null
  const sepIdx = rest.indexOf('__')
  if (sepIdx === -1) {
    return { serverName: rest, isWildcard: true }
  }
  const serverName = rest.slice(0, sepIdx)
  const toolPart = rest.slice(sepIdx + 2)
  if (!serverName) return null
  if (!toolPart || toolPart === '*') {
    return { serverName, isWildcard: true }
  }
  return { serverName, toolName: toolPart, isWildcard: false }
}

/**
 * Returns true if a rule's `toolName` matches a candidate tool (including
 * canonical/legacy aliases, `*`, and `mcp__server` / `mcp__server__*` prefixes).
 */
export function isRuleToolNameMatch(
  ruleToolName: string,
  tool: { readonly name: string; readonly aliases?: readonly string[] },
): boolean {
  const normRule = normalizeLegacyToolName(ruleToolName)
  const normTool = normalizeLegacyToolName(tool.name)

  if (normRule === '*' || normRule === normTool) {
    return true
  }

  if (tool.aliases?.some(alias => normalizeLegacyToolName(alias) === normRule)) {
    return true
  }

  const legacyNames = getLegacyToolNames(normTool)
  if (legacyNames.includes(ruleToolName)) {
    return true
  }

  const parsedRuleMcp = parseMcpRuleName(normRule)
  const parsedToolMcp = parseMcpRuleName(normTool)
  if (parsedRuleMcp && parsedToolMcp) {
    if (parsedRuleMcp.serverName !== parsedToolMcp.serverName) {
      return false
    }
    if (parsedRuleMcp.isWildcard) {
      return true
    }
    return parsedRuleMcp.toolName === parsedToolMcp.toolName
  }

  return false
}
