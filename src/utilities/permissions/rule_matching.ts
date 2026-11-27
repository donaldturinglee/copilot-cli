/**
 * Phase 3 lightweight permission rule parsing, wildcard matching, path
 * containment, and permission context update helpers.
 *
 * Phase 4 expands `src/utilities/permissions/` with full 6-mode evaluation,
 * AST rules, and classifiers while preserving these contracts.
 */

import { relative } from 'path'
import picomatch from 'picomatch'
import type {
  AdditionalWorkingDirectory,
  PermissionBehavior,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionUpdate,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { getCwd } from '../cwd.js'
import { expandPath } from '../path.js'
import { getPlatform } from '../platform.js'
import {
  checkReadPermissionForTool as checkReadPermissionFromFs,
  checkWritePermissionForTool as checkWritePermissionFromFs,
  pathInAllowedWorkingPath as pathInAllowedWorkingPathFromFs,
} from './filesystem.js'

const RULE_SOURCES_PRECEDENCE: readonly PermissionRuleSource[] = [
  'policySettings',
  'flagSettings',
  'cliArg',
  'command',
  'localSettings',
  'projectSettings',
  'userSettings',
  'session',
]

/**
 * Parses a permission rule string of the form `Tool` or `Tool(content)`.
 */
export function parsePermissionRuleValue(rule: string): PermissionRuleValue {
  const trimmed = rule.trim()
  const openIdx = trimmed.indexOf('(')
  if (openIdx === -1 || !trimmed.endsWith(')')) {
    return { toolName: trimmed }
  }
  const toolName = trimmed.slice(0, openIdx).trim()
  const ruleContent = trimmed.slice(openIdx + 1, -1)
  return {
    toolName,
    ...(ruleContent.length > 0 ? { ruleContent } : {}),
  }
}

/**
 * Serializes a `PermissionRuleValue` back into canonical `Tool` or `Tool(content)` format.
 */
export function formatPermissionRuleValue(value: PermissionRuleValue): string {
  return value.ruleContent !== undefined
    ? `${value.toolName}(${value.ruleContent})`
    : value.toolName
}

function collectRulesForBehavior(
  rulesBySource: DeepImmutable<ToolPermissionRulesBySource> | undefined,
  behavior: PermissionBehavior,
): PermissionRule[] {
  if (!rulesBySource) {
    return []
  }
  const rules: PermissionRule[] = []
  for (const source of RULE_SOURCES_PRECEDENCE) {
    const entries = rulesBySource[source]
    if (!entries) continue
    for (const raw of entries) {
      rules.push({
        source,
        ruleBehavior: behavior,
        ruleValue: parsePermissionRuleValue(raw),
      })
    }
  }
  return rules
}

function ruleMatchesToolName(
  ruleToolName: string,
  tool: { readonly name: string; readonly aliases?: readonly string[] },
): boolean {
  if (ruleToolName === '*' || ruleToolName === tool.name) {
    return true
  }
  if (tool.aliases?.includes(ruleToolName)) {
    return true
  }
  // Support MCP server prefix rules like `mcp__server` matching `mcp__server__tool`
  if (
    ruleToolName.startsWith('mcp__') &&
    tool.name.startsWith(`${ruleToolName}__`)
  ) {
    return true
  }
  return false
}

/**
 * Returns a blanket (content-less) rule matching `tool` for the given behavior,
 * if one exists in `permissionContext`.
 */
export function getBlanketRuleForTool(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  behavior: PermissionBehavior,
): PermissionRule | undefined {
  const sourceMap =
    behavior === 'deny'
      ? permissionContext.alwaysDenyRules
      : behavior === 'ask'
        ? permissionContext.alwaysAskRules
        : permissionContext.alwaysAllowRules
  const rules = collectRulesForBehavior(sourceMap, behavior)
  return rules.find(
    rule =>
      rule.ruleValue.ruleContent === undefined &&
      ruleMatchesToolName(rule.ruleValue.toolName, tool),
  )
}

/**
 * Returns a blanket deny rule matching `tool` (used by `filterToolsByDenyRules`).
 */
export function getDenyRuleForTool(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  tool: { readonly name: string; readonly aliases?: readonly string[] },
): PermissionRule | undefined {
  return getBlanketRuleForTool(permissionContext, tool, 'deny')
}

/**
 * Returns all rules (with or without content) matching `tool` for `behavior`.
 */
export function getRulesForTool(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  behavior: PermissionBehavior,
): PermissionRule[] {
  const sourceMap =
    behavior === 'deny'
      ? permissionContext.alwaysDenyRules
      : behavior === 'ask'
        ? permissionContext.alwaysAskRules
        : permissionContext.alwaysAllowRules
  return collectRulesForBehavior(sourceMap, behavior).filter(rule =>
    ruleMatchesToolName(rule.ruleValue.toolName, tool),
  )
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Matches a candidate string or path against a glob/wildcard rule content pattern.
 */
export function matchWildcardPattern(
  candidate: string,
  pattern: string,
): boolean {
  const normCandidate = normalizePosix(candidate)
  let normPattern = normalizePosix(pattern.trim())
  if (!normPattern) return false

  // Support legacy `prefix:*` rule syntax
  if (normPattern.endsWith(':*')) {
    const prefix = normPattern.slice(0, -2)
    return (
      normCandidate === prefix || normCandidate.startsWith(`${prefix} `)
    )
  }

  // `//abs/path` syntax means absolute path from filesystem root
  if (normPattern.startsWith('//')) {
    normPattern = normPattern.slice(1)
  }

  try {
    const isWindows = getPlatform() === 'windows'
    const matcher = picomatch(normPattern, {
      dot: true,
      nocase: isWindows,
    })
    if (matcher(normCandidate)) {
      return true
    }
    const rel = normalizePosix(relative(getCwd(), candidate))
    if (rel && !rel.startsWith('..') && matcher(rel)) {
      return true
    }
    return false
  } catch {
    return normCandidate === normPattern
  }
}

/**
 * Collects path-based deny patterns for file-reading tools (`Read`, `Glob`, `Grep`).
 */
export function getFileReadIgnorePatterns(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  toolName = 'Read',
): string[] {
  const denyRules = getRulesForTool(
    permissionContext,
    { name: toolName },
    'deny',
  )
  const patterns: string[] = []
  for (const rule of denyRules) {
    if (rule.ruleValue.ruleContent) {
      patterns.push(rule.ruleValue.ruleContent)
    }
  }
  return patterns
}

/**
 * Checks whether `targetPath` lies within the current working directory,
 * original working directory, or any configured `additionalWorkingDirectories`.
 */
export function pathInAllowedWorkingPath(
  targetPath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): boolean {
  return pathInAllowedWorkingPathFromFs(targetPath, permissionContext)
}

/**
 * Evaluates read permission for a file or directory path against deny/ask/allow
 * rules, suspicious Windows path guards, and working-directory boundaries.
 */
export function checkReadPermissionForTool<Input extends Record<string, unknown>>(
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  input: Input,
  filePath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): PermissionResult<Input> {
  return checkReadPermissionFromFs(tool, input, filePath, permissionContext)
}

/**
 * Evaluates write/edit permission for a file path against deny rules,
 * sensitive-path `safetyCheck` (immune to `bypassPermissions`), ask rules,
 * `plan` mode, allow rules, and `acceptEdits`.
 */
export function checkWritePermissionForTool<
  Input extends Record<string, unknown>,
>(
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  input: Input,
  filePath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): PermissionResult<Input> {
  return checkWritePermissionFromFs(tool, input, filePath, permissionContext)
}

export function cloneRulesBySource(
  rules: DeepImmutable<ToolPermissionRulesBySource> | undefined,
): ToolPermissionRulesBySource {
  const result: ToolPermissionRulesBySource = {}
  if (!rules) return result
  for (const source of RULE_SOURCES_PRECEDENCE) {
    const entries = rules[source]
    if (entries) {
      result[source] = [...entries]
    }
  }
  return result
}

/**
 * Pure reducer applying a single `PermissionUpdate` to a `ToolPermissionContext`.
 */
export function applyPermissionUpdate(
  context: DeepImmutable<ToolPermissionContext>,
  update: PermissionUpdate,
): ToolPermissionContext {
  const nextAllow = cloneRulesBySource(context.alwaysAllowRules)
  const nextDeny = cloneRulesBySource(context.alwaysDenyRules)
  const nextAsk = cloneRulesBySource(context.alwaysAskRules)
  const nextStripped = context.strippedDangerousRules
    ? cloneRulesBySource(context.strippedDangerousRules)
    : undefined
  const nextDirs = new Map<string, AdditionalWorkingDirectory>(
    context.additionalWorkingDirectories,
  )

  const base: ToolPermissionContext = {
    ...context,
    additionalWorkingDirectories: nextDirs,
    alwaysAllowRules: nextAllow,
    alwaysDenyRules: nextDeny,
    alwaysAskRules: nextAsk,
    ...(nextStripped ? { strippedDangerousRules: nextStripped } : { strippedDangerousRules: undefined }),
  }

  const pickTarget = (behavior: PermissionBehavior) =>
    behavior === 'allow'
      ? nextAllow
      : behavior === 'deny'
        ? nextDeny
        : nextAsk

  switch (update.type) {
    case 'addRules': {
      const target = pickTarget(update.behavior)
      const existing = target[update.destination] ?? []
      const formatted = update.rules.map(formatPermissionRuleValue)
      target[update.destination] = Array.from(
        new Set([...existing, ...formatted]),
      )
      return base
    }
    case 'replaceRules': {
      const target = pickTarget(update.behavior)
      target[update.destination] = update.rules.map(formatPermissionRuleValue)
      return base
    }
    case 'removeRules': {
      const target = pickTarget(update.behavior)
      const toRemove = new Set(update.rules.map(formatPermissionRuleValue))
      const existing = target[update.destination] ?? []
      target[update.destination] = existing.filter(r => !toRemove.has(r))
      return base
    }
    case 'setMode':
      return {
        ...base,
        mode: update.mode,
      }
    case 'addDirectories': {
      for (const dir of update.directories) {
        const expanded = expandPath(dir)
        nextDirs.set(expanded, {
          path: expanded,
          source: update.destination,
        })
      }
      return base
    }
    case 'removeDirectories': {
      for (const dir of update.directories) {
        nextDirs.delete(expandPath(dir))
      }
      return base
    }
  }
}

/**
 * Pure reducer applying a sequence of `PermissionUpdate` items.
 */
export function applyPermissionUpdates(
  context: DeepImmutable<ToolPermissionContext>,
  updates: readonly PermissionUpdate[],
): ToolPermissionContext {
  let current: ToolPermissionContext = {
    ...context,
    additionalWorkingDirectories: new Map(context.additionalWorkingDirectories),
    alwaysAllowRules: cloneRulesBySource(context.alwaysAllowRules),
    alwaysDenyRules: cloneRulesBySource(context.alwaysDenyRules),
    alwaysAskRules: cloneRulesBySource(context.alwaysAskRules),
    ...(context.strippedDangerousRules
      ? { strippedDangerousRules: cloneRulesBySource(context.strippedDangerousRules) }
      : { strippedDangerousRules: undefined }),
  }
  for (const update of updates) {
    current = applyPermissionUpdate(current, update)
  }
  return current
}
