/**
 * Filesystem path safety checks, dangerous file/directory guards, Windows path
 * bypass detection, gitignore-style path rule matching, and read/write
 * permission evaluation.
 *
 * SECURITY INVARIANT: Sensitive-path write checks (`checkPathSafetyForAutoEdit`)
 * return `{ behavior: 'ask', decisionReason: { type: 'safetyCheck', ... } }` so
 * `hasPermissionsToUseTool()` makes them IMMUNE to `bypassPermissions` and
 * `acceptEdits`!
 */

import { homedir, tmpdir } from 'os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'path'
import picomatch from 'picomatch'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type {
  PermissionBehavior,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  ToolPermissionContext,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { getCwd } from '../cwd.js'
import { getGlobalClaudeFile } from '../env.js'
import { getClaudeConfigHomeDir } from '../env_utils.js'
import { getPathsForPermissionCheck } from '../fs_operations.js'
import { expandPath } from '../path.js'
import { getPlatform } from '../platform.js'
import { getManagedFilePath } from '../settings/managed_path.js'
import { getSettingsFilePathForSource } from '../settings/settings.js'
import {
  isRuleToolNameMatch,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permission_rule_parser.js'

/**
 * Sensitive configuration / shell startup files whose modification can execute
 * arbitrary code (git hooks/aliases, shell profiles, ripgrep/MCP configs, CLI
 * config). Checked case-insensitively on every path segment / basename.
 */
export const DANGEROUS_FILES: readonly string[] = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.copilot.json',
]

/**
 * Sensitive directories whose contents affect code execution, IDE tasks, git
 * internals, or CLI policy/skills/hooks.
 */
export const DANGEROUS_DIRECTORIES: readonly string[] = [
  '.git',
  '.vscode',
  '.idea',
  '.copilot',
]

const DANGEROUS_FILES_LOWER = new Set(DANGEROUS_FILES.map(f => f.toLowerCase()))
const DANGEROUS_DIRS_LOWER = new Set(
  DANGEROUS_DIRECTORIES.map(d => d.toLowerCase()),
)

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

const WINDOWS_DOS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const WINDOWS_SHORT_NAME_RE = /~\d+(?:\.[^./\\]+)?$/
const WINDOWS_DEVICE_PREFIX_RE = /^(?:\\\\[?.]\\|\/\/[?.]\/)/
const UNC_PATH_RE = /^(?:\\\\[^?.\\]|\/\/[^?./])/

/**
 * Returns the Copilot CLI process temp directory (`<tmpdir>/copilot-<uid>`).
 */
export function getCopilotTempDir(): string {
  const uid =
    typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  return join(tmpdir(), `copilot-${uid}`)
}

/**
 * Returns the sanitized project-scoped temp directory inside Copilot temp dir.
 */
export function getProjectTempDir(projectPath = getOriginalCwd()): string {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9_-]/g, '-')
  return join(getCopilotTempDir(), sanitized)
}

/**
 * Detects Windows / NTFS path parsing tricks that can evade string-based path
 * allow/deny checks:
 * - NTFS Alternate Data Streams (`file.txt:stream`, `.gitconfig::$DATA`)
 * - 8.3 short filenames (`GIT~1`, `COPILO~1`)
 * - Device namespace prefixes (`\\?\`, `\\.\`)
 * - UNC paths (`\\host\share`, `//host/share`)
 * - Trailing dots or spaces on path segments (`.git.`, `.gitconfig `)
 * - Multi-dot traversal segments (`...`)
 * - Reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`)
 */
export function hasSuspiciousWindowsPathPattern(filePath: string): boolean {
  if (!filePath) return false

  // Device namespace prefix (`\\?\` or `\\.\`)
  if (WINDOWS_DEVICE_PREFIX_RE.test(filePath)) {
    return true
  }

  // UNC path (`\\server\share` or `//server/share`)
  if (UNC_PATH_RE.test(filePath)) {
    return true
  }

  // NTFS Alternate Data Stream: colon anywhere outside drive letter `C:`
  const afterDrive = /^[a-zA-Z]:/.test(filePath)
    ? filePath.slice(2)
    : filePath
  if (afterDrive.includes(':')) {
    return true
  }

  const segments = afterDrive.split(/[\\/]+/).filter(Boolean)
  for (const segment of segments) {
    // Three or more consecutive dots (`...`, `....`)
    if (/^\.{3,}$/.test(segment)) {
      return true
    }
    // Trailing dots or spaces (NTFS strips them silently: `.git.` -> `.git`)
    if (segment !== '.' && segment !== '..' && /[. ]$/.test(segment)) {
      return true
    }
    // 8.3 short filename (`GIT~1`, `PROGRA~1`, `COPILO~1`)
    if (WINDOWS_SHORT_NAME_RE.test(segment)) {
      return true
    }
    // DOS reserved device name (`NUL`, `CON.txt`, `AUX`)
    if (WINDOWS_DOS_DEVICE_RE.test(segment)) {
      return true
    }
  }

  return false
}

function normalizeForComparison(filePath: string): string {
  const resolved = normalize(resolve(filePath))
  return getPlatform() === 'windows' ? resolved.toLowerCase() : resolved
}

/**
 * Returns true if `filePath` is any Copilot CLI settings file
 * (`~/.copilot/settings.json`, `<project>/.copilot/settings.json`,
 * `<project>/.copilot/settings.local.json`, managed settings, or flag settings).
 */
export function isCopilotSettingsPath(filePath: string): boolean {
  const candidates = getPathsForPermissionCheck(expandPath(filePath))
  const knownSettings = new Set<string>()
  const sources = [
    'userSettings',
    'projectSettings',
    'localSettings',
    'policySettings',
    'flagSettings',
  ] as const

  for (const source of sources) {
    const p = getSettingsFilePathForSource(source)
    if (p) {
      knownSettings.add(normalizeForComparison(p))
    }
  }
  knownSettings.add(normalizeForComparison(getManagedFilePath()))
  knownSettings.add(
    normalizeForComparison(join(getCwd(), '.copilot', 'settings.json')),
  )
  knownSettings.add(
    normalizeForComparison(join(getCwd(), '.copilot', 'settings.local.json')),
  )
  knownSettings.add(
    normalizeForComparison(join(getClaudeConfigHomeDir(), 'settings.json')),
  )

  return candidates.some(c => knownSettings.has(normalizeForComparison(c)))
}

/**
 * Returns true if `filePath` is the global `~/.copilot.json` config file.
 */
export function isCopilotConfigFilePath(filePath: string): boolean {
  const target = normalizeForComparison(getGlobalClaudeFile())
  const candidates = getPathsForPermissionCheck(expandPath(filePath))
  return candidates.some(c => normalizeForComparison(c) === target)
}

export interface PathSafetyCheckResult {
  safe: boolean
  message?: string
  classifierApprovable: boolean
}

function checkSinglePathForDanger(filePath: string): PathSafetyCheckResult {
  if (hasSuspiciousWindowsPathPattern(filePath)) {
    return {
      safe: false,
      message: `Refusing automatic edit of suspicious Windows/NTFS path pattern: ${filePath}`,
      classifierApprovable: false,
    }
  }

  if (isCopilotSettingsPath(filePath)) {
    return {
      safe: false,
      message: `Cannot automatically edit Copilot settings file: ${filePath}`,
      classifierApprovable: false,
    }
  }

  if (isCopilotConfigFilePath(filePath)) {
    return {
      safe: false,
      message: `Cannot automatically edit Copilot configuration file: ${filePath}`,
      classifierApprovable: false,
    }
  }

  const normalized = normalize(filePath)
  const segments = normalized.split(/[\\/]+/).filter(Boolean)

  for (let i = 0; i < segments.length; i++) {
    const segLower = segments[i]!.toLowerCase()

    // Check dangerous files (basename or any matching filename segment)
    if (DANGEROUS_FILES_LOWER.has(segLower)) {
      return {
        safe: false,
        message: `Cannot automatically edit sensitive file '${segments[i]}' (${filePath})`,
        classifierApprovable: false,
      }
    }

    // Check dangerous directories (`.git`, `.vscode`, `.idea`, `.copilot`)
    if (DANGEROUS_DIRS_LOWER.has(segLower)) {
      // Allow `.copilot/worktrees/...` (structural worktree storage, mirroring v1 `.claude/worktrees`)
      // and `.copilot/plans/...` when writing plan markdown files? Wait: `.copilot/worktrees/` is
      // safe for nested repo files; keep `.copilot/skills`, `.copilot/commands`, `.copilot/agents`,
      // `.copilot/settings*.json` strictly protected.
      const nextSeg = segments[i + 1]?.toLowerCase()
      if (segLower === '.copilot' && nextSeg === 'worktrees') {
        continue
      }
      return {
        safe: false,
        message: `Cannot automatically edit inside protected directory '${segments[i]}' (${filePath})`,
        classifierApprovable: false,
      }
    }
  }

  return { safe: true, classifierApprovable: true }
}

/**
 * Checks whether editing/writing `filePath` is safe for automatic approval
 * (`acceptEdits` / `bypassPermissions` / `auto`). Checks BOTH the raw input
 * path and every symlink-resolved path to defeat symlink-escape attacks.
 */
export function checkPathSafetyForAutoEdit(
  filePath: string,
): PathSafetyCheckResult {
  // Check raw path BEFORE expansion/normalization so Windows tricks like
  // `.gitconfig.`, `file:stream`, `GIT~1`, or `\\?\C:\...` are caught immediately.
  const rawCheck = checkSinglePathForDanger(filePath)
  if (!rawCheck.safe) {
    return rawCheck
  }

  const expanded = expandPath(filePath)
  const pathsToCheck = getPathsForPermissionCheck(expanded)
  for (const candidate of pathsToCheck) {
    const res = checkSinglePathForDanger(candidate)
    if (!res.safe) {
      return res
    }
  }

  return { safe: true, classifierApprovable: true }
}

function isPathInsideDir(targetPath: string, dirPath: string): boolean {
  const normTarget = normalizeForComparison(targetPath)
  const normDir = normalizeForComparison(dirPath)
  if (normTarget === normDir) {
    return true
  }
  const prefix = normDir.endsWith(sep) ? normDir : `${normDir}${sep}`
  return normTarget.startsWith(prefix)
}

export function pathInWorkingPath(
  targetPath: string,
  cwd: string = getCwd(),
): boolean {
  const absolute = isAbsolute(targetPath) ? targetPath : expandPath(targetPath)
  const pathsToCheck = getPathsForPermissionCheck(absolute)
  return pathsToCheck.every(candidate => isPathInsideDir(candidate, cwd))
}

export function pathInAllowedWorkingPath(
  targetPath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): boolean {
  const absolute = isAbsolute(targetPath) ? targetPath : expandPath(targetPath)
  const pathsToCheck = getPathsForPermissionCheck(absolute)

  const allowedDirs = new Set<string>([
    getCwd(),
    getOriginalCwd(),
    getCopilotTempDir(),
  ])
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

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Resolves a gitignore-style path rule pattern into a normalized POSIX glob
 * against the rule's root directory:
 * - `//path` -> filesystem root absolute path (`/path` or Windows drive path)
 * - `~/path` -> home directory path
 * - `/path` -> relative to project/settings root
 * - `path` -> relative to cwd (or anywhere if no slash, e.g. `*.env`)
 */
export function normalizePathRulePattern(
  pattern: string,
  baseDir: string = getCwd(),
): { glob: string; matchRelative: boolean } {
  const trimmed = toPosix(pattern.trim())
  if (!trimmed) {
    return { glob: '', matchRelative: false }
  }
  if (trimmed.startsWith('//')) {
    // `//etc/passwd` -> `/etc/passwd`, `//C:/Users/...` -> `C:/Users/...`
    const stripped = trimmed.slice(1)
    if (/^\/[a-zA-Z]:\//.test(stripped)) {
      return { glob: stripped.slice(1), matchRelative: false }
    }
    return { glob: stripped, matchRelative: false }
  }
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    const home = toPosix(homedir())
    return {
      glob: `${home}${trimmed.slice(1)}`,
      matchRelative: false,
    }
  }
  if (trimmed.startsWith('/')) {
    const joined = toPosix(resolve(baseDir, trimmed.slice(1)))
    return { glob: joined, matchRelative: false }
  }
  // Windows drive-letter absolute pattern like `C:/foo/**`
  if (/^[a-zA-Z]:\//.test(trimmed)) {
    return { glob: trimmed, matchRelative: false }
  }
  return { glob: trimmed, matchRelative: true }
}

/**
 * Matches a concrete file path against a gitignore/glob rule pattern.
 */
export function matchGitignorePathPattern(
  filePath: string,
  pattern: string,
  baseDir: string = getCwd(),
): boolean {
  const normFile = toPosix(resolve(expandPath(filePath)))
  const { glob, matchRelative } = normalizePathRulePattern(pattern, baseDir)
  if (!glob) return false

  const isWindows = getPlatform() === 'windows'
  const opts = { dot: true, nocase: isWindows }

  try {
    const matcher = picomatch(glob, opts)
    if (matcher(normFile)) {
      return true
    }

    if (matchRelative) {
      const rel = toPosix(relative(baseDir, normFile))
      if (rel && !rel.startsWith('..') && matcher(rel)) {
        return true
      }
      // Gitignore semantics: pattern without slash (e.g. `.env`, `*.key`) matches
      // the basename at any directory depth.
      if (!glob.includes('/')) {
        const baseMatcher = picomatch(`**/${glob}`, opts)
        if (baseMatcher(normFile) || matcher(basename(normFile))) {
          return true
        }
      } else {
        // Also try anchored under baseDir
        const anchored = toPosix(resolve(baseDir, glob))
        if (picomatch(anchored, opts)(normFile)) {
          return true
        }
      }
    }

    // Directory prefix rule without `/**` (e.g. `secrets/` or `.git`)
    if (glob.endsWith('/')) {
      const dirGlob = `${glob}**`
      const dirMatcher = picomatch(dirGlob, opts)
      if (dirMatcher(normFile)) {
        return true
      }
      const rel = toPosix(relative(baseDir, normFile))
      if (rel && !rel.startsWith('..') && dirMatcher(rel)) {
        return true
      }
    }

    return false
  } catch {
    return normFile === glob
  }
}

function getRulesForFileTool(
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
  const matched: PermissionRule[] = []
  for (const source of RULE_SOURCES_PRECEDENCE) {
    const entries = sourceMap[source]
    if (!entries) continue
    for (const raw of entries) {
      const ruleValue = permissionRuleValueFromString(raw)
      if (isRuleToolNameMatch(ruleValue.toolName, tool)) {
        matched.push({ source, ruleBehavior: behavior, ruleValue })
      }
    }
  }
  return matched
}

function findMatchingFileRule(
  filePath: string,
  rules: readonly PermissionRule[],
): PermissionRule | undefined {
  const expanded = expandPath(filePath)
  const candidates = getPathsForPermissionCheck(expanded)
  const cwd = getCwd()

  for (const rule of rules) {
    const content = rule.ruleValue.ruleContent
    if (content === undefined) {
      return rule
    }
    if (
      candidates.some(candidate =>
        matchGitignorePathPattern(candidate, content, cwd),
      )
    ) {
      return rule
    }
  }
  return undefined
}

/**
 * Evaluates read permission for a file/directory tool (`Read`, `Glob`, `Grep`).
 * Precedence: deny rules > ask rules > allow rules > working directory containment > ask.
 */
export function checkReadPermissionForTool<
  Input extends Record<string, unknown>,
>(
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  input: Input,
  filePath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): PermissionResult<Input> {
  // Block suspicious Windows path patterns on reads as well
  if (hasSuspiciousWindowsPathPattern(filePath)) {
    const msg = `Refusing read of suspicious Windows/NTFS path pattern: ${filePath}`
    return {
      behavior: 'ask',
      message: msg,
      updatedInput: input,
      blockedPath: filePath,
      decisionReason: {
        type: 'safetyCheck',
        reason: msg,
        classifierApprovable: false,
      },
    }
  }

  const denyMatch = findMatchingFileRule(
    filePath,
    getRulesForFileTool(permissionContext, tool, 'deny'),
  )
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `Permission to read ${filePath} has been denied by rule ${permissionRuleValueToString(denyMatch.ruleValue)}.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }

  const askMatch = findMatchingFileRule(
    filePath,
    getRulesForFileTool(permissionContext, tool, 'ask'),
  )
  if (askMatch) {
    return {
      behavior: 'ask',
      message: `Permission required to read ${filePath}.`,
      updatedInput: input,
      blockedPath: filePath,
      decisionReason: { type: 'rule', rule: askMatch },
    }
  }

  const allowMatch = findMatchingFileRule(
    filePath,
    getRulesForFileTool(permissionContext, tool, 'allow'),
  )
  if (allowMatch) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: allowMatch },
    }
  }

  if (pathInAllowedWorkingPath(filePath, permissionContext)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'workingDir',
        reason: 'Path is inside an allowed working directory',
      },
    }
  }

  const targetDir = dirname(expandPath(filePath))
  return {
    behavior: 'ask',
    message: `${tool.name} wants to read outside the allowed working directory: ${filePath}`,
    updatedInput: input,
    blockedPath: filePath,
    decisionReason: {
      type: 'workingDir',
      reason: `Path is outside the working directory (${getCwd()})`,
    },
    suggestions: [
      {
        type: 'addDirectories',
        directories: [targetDir],
        destination: 'session',
      },
    ],
  }
}

/**
 * Evaluates write/edit permission for file mutation tools (`Edit`, `Write`, `NotebookEdit`).
 *
 * Security precedence:
 * 1. Explicit `deny` rules (always win)
 * 2. Sensitive-path `safetyCheck` (`.git`, `.copilot`, `.gitconfig`, shell rc, Windows tricks)
 *    -> returns `{ behavior: 'ask', decisionReason: { type: 'safetyCheck', ... } }` which is
 *    IMMUNE to `bypassPermissions` and `acceptEdits`!
 * 3. Explicit `ask` rules (also immune to `bypassPermissions` in `hasPermissionsToUseTool`)
 * 4. `plan` mode guard (blocks edits outside the plan file)
 * 5. Explicit `allow` rules
 * 6. `acceptEdits` inside allowed working directories -> `allow`
 * 7. Default -> `ask` with `addRules` / `addDirectories` suggestions
 */
export function checkWritePermissionForTool<
  Input extends Record<string, unknown>,
>(
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  input: Input,
  filePath: string,
  permissionContext: DeepImmutable<ToolPermissionContext>,
  options?: { allowedPlanFilePath?: string },
): PermissionResult<Input> {
  // 1. Explicit deny rules always take precedence
  const denyMatch = findMatchingFileRule(
    filePath,
    getRulesForFileTool(permissionContext, tool, 'deny'),
  )
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `Permission to modify ${filePath} has been denied by rule ${permissionRuleValueToString(denyMatch.ruleValue)}.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }

  // 2. Sensitive-path safetyCheck (immune to bypassPermissions & acceptEdits!)
  const safety = checkPathSafetyForAutoEdit(filePath)
  if (!safety.safe) {
    const reason = safety.message ?? `Sensitive path requires confirmation: ${filePath}`
    return {
      behavior: 'ask',
      message: reason,
      updatedInput: input,
      blockedPath: filePath,
      decisionReason: {
        type: 'safetyCheck',
        reason,
        classifierApprovable: safety.classifierApprovable,
      },
    }
  }

  // 3. Explicit ask rules
  const askMatch = findMatchingFileRule(
    filePath,
    getRulesForFileTool(permissionContext, tool, 'ask'),
  )
  if (askMatch) {
    return {
      behavior: 'ask',
      message: `Permission required to modify ${filePath}.`,
      updatedInput: input,
      blockedPath: filePath,
      decisionReason: { type: 'rule', rule: askMatch },
    }
  }

  // 4. Plan mode blocks writes except the designated plan file
  if (permissionContext.mode === 'plan') {
    const expandedTarget = normalizeForComparison(expandPath(filePath))
    const expandedPlan = options?.allowedPlanFilePath
      ? normalizeForComparison(expandPath(options.allowedPlanFilePath))
      : undefined
    if (expandedPlan && expandedTarget === expandedPlan) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'mode', mode: 'plan' },
      }
    }
    return {
      behavior: 'deny',
      message: `Plan mode does not allow modifying ${filePath}. Exit plan mode first.`,
      decisionReason: { type: 'mode', mode: 'plan' },
    }
  }

  // 5. Explicit allow rules
  const allowMatch = findMatchingFileRule(
    filePath,
    getRulesForFileTool(permissionContext, tool, 'allow'),
  )
  if (allowMatch) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: allowMatch },
    }
  }

  // 6. `acceptEdits` auto-approves safe writes inside allowed working dirs
  const inWorkingPath = pathInAllowedWorkingPath(filePath, permissionContext)
  if (permissionContext.mode === 'acceptEdits' && inWorkingPath) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'mode', mode: 'acceptEdits' },
    }
  }

  const targetDir = dirname(expandPath(filePath))
  return {
    behavior: 'ask',
    message: `${tool.name} wants to modify ${filePath}.`,
    updatedInput: input,
    blockedPath: filePath,
    decisionReason: inWorkingPath
      ? { type: 'mode', mode: permissionContext.mode }
      : {
          type: 'workingDir',
          reason: `Path is outside the working directory (${getCwd()})`,
        },
    suggestions: inWorkingPath
      ? [
          {
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          },
        ]
      : [
          {
            type: 'addDirectories',
            directories: [targetDir],
            destination: 'session',
          },
        ],
  }
}
