/**
 * Phase 3 lightweight permission rule parsing, wildcard matching, path
 * containment, and permission context update helpers.
 *
 * Phase 4 expands `src/utilities/permissions/` with full 6-mode evaluation,
 * AST rules, and classifiers while preserving these contracts.
 */

import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'path'
import picomatch from 'picomatch'
import { getOriginalCwd } from '../../bootstrap/state.js'
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
import { getPathsForPermissionCheck } from '../fs_operations.js'
import { expandPath } from '../path.js'
import { getPlatform } from '../platform.js'

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

function normalizeForContainment(filePath: string): string {
  const resolved = normalize(resolve(filePath))
  return getPlatform() === 'windows' ? resolved.toLowerCase() : resolved
}

function isPathInsideDir(targetPath: string, dirPath: string): boolean {
  const normTarget = normalizeForContainment(targetPath)
  const normDir = normalizeForContainment(dirPath)
  if (normTarget === normDir) {
    return true
  }
  const prefix = normDir.endsWith(sep) ? normDir : `${normDir}${sep}`
  return normTarget.startsWith(prefix)
}

/**
 * Checks whether `targetPath` lies within the current working directory,
 * original working directory, or any configured `additionalWorkingDirectories`.
 */
export function pathInAllowedWorkingPath(
  targetPath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): boolean {
  const absolute = isAbsolute(targetPath)
    ? targetPath
    : expandPath(targetPath)
  const pathsToCheck = getPathsForPermissionCheck(absolute)

  const allowedDirs = new Set<string>([getCwd(), getOriginalCwd()])
  for (const [dirPath] of permissionContext.additionalWorkingDirectories) {
    allowedDirs.add(dirPath)
  }

  return pathsToCheck.every(candidate => {
    for (const dir of allowedDirs) {
      if (isPathInsideDir(candidate, dir)) {
        return true
      }
    }
    return false
  })
}

function findMatchingPathRule(
  filePath: string,
  rules: readonly PermissionRule[],
): PermissionRule | undefined {
  const pathsToCheck = getPathsForPermissionCheck(expandPath(filePath))
  for (const rule of rules) {
    const content = rule.ruleValue.ruleContent
    if (content === undefined) {
      return rule
    }
    if (pathsToCheck.some(p => matchWildcardPattern(p, content))) {
      return rule
    }
  }
  return undefined
}

/**
 * Evaluates read permission for a file or directory path against deny/ask/allow
 * rules and working-directory boundaries.
 */
export function checkReadPermissionForTool<Input extends Record<string, unknown>>(
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  input: Input,
  filePath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): PermissionResult<Input> {
  const denyMatch = findMatchingPathRule(
    filePath,
    getRulesForTool(permissionContext, tool, 'deny'),
  )
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `Access to ${filePath} is denied by permission rule ${formatPermissionRuleValue(denyMatch.ruleValue)}.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }

  const askMatch = findMatchingPathRule(
    filePath,
    getRulesForTool(permissionContext, tool, 'ask'),
  )
  if (askMatch) {
    return {
      behavior: 'ask',
      message: `Permission required to read ${filePath}.`,
      updatedInput: input,
      decisionReason: { type: 'rule', rule: askMatch },
      blockedPath: filePath,
    }
  }

  const allowMatch = findMatchingPathRule(
    filePath,
    getRulesForTool(permissionContext, tool, 'allow'),
  )
  if (allowMatch) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: allowMatch },
    }
  }

  if (
    permissionContext.mode === 'bypassPermissions' ||
    pathInAllowedWorkingPath(filePath, permissionContext)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'workingDir', reason: 'Path is in working directory' },
    }
  }

  return {
    behavior: 'ask',
    message: `File ${filePath} is outside the allowed working directories.`,
    updatedInput: input,
    blockedPath: filePath,
    decisionReason: {
      type: 'workingDir',
      reason: `Outside working directory (${dirname(filePath)})`,
    },
  }
}

/**
 * Evaluates write/edit permission for a file path against deny/ask/allow rules
 * and permission mode (`acceptEdits` / `bypassPermissions` / `plan`).
 */
export function checkWritePermissionForTool<
  Input extends Record<string, unknown>,
>(
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  input: Input,
  filePath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): PermissionResult<Input> {
  const denyMatch = findMatchingPathRule(
    filePath,
    getRulesForTool(permissionContext, tool, 'deny'),
  )
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `Editing ${filePath} is denied by permission rule ${formatPermissionRuleValue(denyMatch.ruleValue)}.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }

  const askMatch = findMatchingPathRule(
    filePath,
    getRulesForTool(permissionContext, tool, 'ask'),
  )
  if (askMatch) {
    return {
      behavior: 'ask',
      message: `Permission required to edit ${filePath}.`,
      updatedInput: input,
      decisionReason: { type: 'rule', rule: askMatch },
      blockedPath: filePath,
    }
  }

  if (permissionContext.mode === 'plan') {
    return {
      behavior: 'deny',
      message: `Cannot edit ${filePath} while in plan mode.`,
      decisionReason: { type: 'mode', mode: 'plan' },
    }
  }

  const allowMatch = findMatchingPathRule(
    filePath,
    getRulesForTool(permissionContext, tool, 'allow'),
  )
  if (allowMatch) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: allowMatch },
    }
  }

  if (
    permissionContext.mode === 'bypassPermissions' ||
    (permissionContext.mode === 'acceptEdits' &&
      pathInAllowedWorkingPath(filePath, permissionContext))
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'mode', mode: permissionContext.mode },
    }
  }

  return {
    behavior: 'ask',
    message: `Allow editing ${filePath}?`,
    updatedInput: input,
    blockedPath: filePath,
    decisionReason: { type: 'mode', mode: permissionContext.mode },
  }
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
