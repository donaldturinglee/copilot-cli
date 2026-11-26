/**
 * Layered `INSTRUCTIONS.md` and `.copilot/rules/*.md` memory loader with `@include`
 * directive expansion, HTML comment stripping, `claudeMdExcludes` glob filtering,
 * and conditional `paths:` rules matching.
 */

import { realpathSync } from 'fs'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { Lexer, type Token, type Tokens } from 'marked'
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'path'
import picomatch from 'picomatch'
import {
  getAdditionalDirectoriesForClaudeMd,
  getAllowedSettingSources,
  getOriginalCwd,
} from '../bootstrap/state.js'
import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import type { MemoryType } from '../types/forward.js'
import {
  getGlobalConfig,
  getManagedClaudeRulesDir,
  getMemoryPath,
  getUserClaudeRulesDir,
} from './config.js'
import { isEnvTruthy } from './env_utils.js'
import { isFeatureEnabled } from './feature_flags.js'
import { parseFrontmatter, splitPathInFrontmatter } from './frontmatter_parser.js'
import { getFsImplementation, safeResolvePath } from './fs_operations.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import { expandPath } from './path.js'
import { getInitialSettings } from './settings/settings.js'
import type { SettingSource } from './settings/constants.js'

function normalizePathForComparison(filePath: string): string {
  const normalized = normalize(resolve(filePath))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathInOriginalCwd(filePath: string): boolean {
  const orig = resolve(getOriginalCwd())
  const target = resolve(filePath)
  const rel = relative(orig, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isSettingSourceEnabled(source: SettingSource): boolean {
  const allowed = getAllowedSettingSources()
  return allowed.includes(source)
}

export const MAX_MEMORY_CHARACTER_COUNT = 40_000
export const MAX_INCLUDE_DEPTH = 5
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

export interface MemoryFileInfo {
  path: string
  type: MemoryType
  content: string
  parent?: string
  globs?: string[]
  isConditional?: boolean
  contentDiffersFromDisk?: boolean
  rawContent?: string
}

const TEXT_FILE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.json',
  '.jsonc',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.hpp',
  '.cs',
  '.swift',
  '.m',
  '.mm',
  '.php',
  '.pl',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  '.dockerfile',
  '.makefile',
  '.cmake',
  '.gradle',
  '.rst',
  '.adoc',
  '.tex',
  '.org',
  '.csv',
  '.tsv',
  '.log',
  '.diff',
  '.patch',
  '.vue',
  '.svelte',
  '.astro',
  '.lua',
  '.r',
  '.jl',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.ml',
  '.mli',
  '.clj',
  '.cljs',
  '.dart',
  '.zig',
  '.nim',
  '.v',
  '.tf',
  '.tfvars',
  '.hcl',
  '.nix',
])

const INCLUDE_DIRECTIVE_REGEX = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g

let autoMemEntrypointGetter: (() => string | null) | undefined
let teamMemEntrypointGetter: (() => string | null) | undefined

/**
 * Registers optional Phase 7 memory entrypoint providers (`MEMORY.md` / team memory).
 */
export function registerClaudeMdMemoryProviders(providers: {
  getAutoMemEntrypoint?: () => string | null
  getTeamMemEntrypoint?: () => string | null
}): void {
  if (providers.getAutoMemEntrypoint) {
    autoMemEntrypointGetter = providers.getAutoMemEntrypoint
  }
  if (providers.getTeamMemEntrypoint) {
    teamMemEntrypointGetter = providers.getTeamMemEntrypoint
  }
}

function isAllowedTextExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  if (!ext) {
    return true
  }
  return TEXT_FILE_EXTENSIONS.has(ext)
}

function pathIsInside(childPath: string, parentDir: string): boolean {
  const rel = relative(resolve(parentDir), resolve(childPath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function resolveExcludePatterns(rawPatterns: readonly string[]): string[] {
  const expanded: string[] = []
  for (const pattern of rawPatterns) {
    expanded.push(pattern)
    if (isAbsolute(pattern)) {
      const wildcardIdx = pattern.search(/[*?[\]{}]/g)
      const staticPrefix =
        wildcardIdx === -1
          ? pattern
          : dirname(pattern.slice(0, wildcardIdx))
      try {
        const realPrefix = realpathSync(staticPrefix)
        if (realPrefix !== staticPrefix) {
          expanded.push(realPrefix + pattern.slice(staticPrefix.length))
        }
      } catch {
        // Static prefix does not exist on disk
      }
    }
  }
  return expanded
}

function isExcludedBySettings(filePath: string, type: MemoryType): boolean {
  if (type === 'Managed' || type === 'AutoMem' || type === 'TeamMem') {
    return false
  }
  const excludes = getInitialSettings().claudeMdExcludes
  if (!excludes || excludes.length === 0) {
    return false
  }
  const normalizedPath = filePath.replace(/\\/g, '/')
  const patterns = resolveExcludePatterns(excludes).map(p =>
    p.replace(/\\/g, '/'),
  )
  return picomatch.isMatch(normalizedPath, patterns, { dot: true })
}

function stripClosedHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

function stripHtmlCommentsFromTokens(
  rawBody: string,
  tokens: readonly Token[],
): { text: string; modified: boolean } {
  if (!rawBody.includes('<!--')) {
    return { text: rawBody, modified: false }
  }
  let output = ''
  let modified = false
  for (const token of tokens) {
    if (token.type === 'html') {
      const stripped = stripClosedHtmlComments(token.raw)
      if (stripped !== token.raw) {
        modified = true
      }
      output += stripped
    } else {
      output += token.raw
    }
  }
  return { text: output, modified }
}

function isValidIncludeCandidate(candidate: string): boolean {
  if (!candidate || candidate === '/') {
    return false
  }
  if (
    candidate.startsWith('./') ||
    candidate.startsWith('~/') ||
    candidate.startsWith('/')
  ) {
    return true
  }
  if (candidate.startsWith('@') || /^[#%^&*()]+/.test(candidate)) {
    return false
  }
  return /^[a-zA-Z0-9._-]/.test(candidate)
}

function extractIncludesFromText(text: string, out: string[]): void {
  const regex = new RegExp(INCLUDE_DIRECTIVE_REGEX.source, 'g')
  let match = regex.exec(text)
  while (match !== null) {
    let rawPath = match[1] ?? ''
    const hashIdx = rawPath.indexOf('#')
    if (hashIdx >= 0) {
      rawPath = rawPath.slice(0, hashIdx)
    }
    const unescaped = rawPath.replace(/\\ /g, ' ')
    if (isValidIncludeCandidate(unescaped)) {
      out.push(unescaped)
    }
    match = regex.exec(text)
  }
}

function collectIncludePathsFromTokens(
  tokens: readonly Token[],
  out: string[],
): void {
  for (const token of tokens) {
    if (token.type === 'code' || token.type === 'codespan') {
      continue
    }
    if (token.type === 'html') {
      const residual = stripClosedHtmlComments(token.raw).trim()
      if (residual) {
        extractIncludesFromText(residual, out)
      }
      continue
    }
    if (token.type === 'text' && 'text' in token && typeof token.text === 'string') {
      extractIncludesFromText(token.text, out)
    }
    if ('tokens' in token && Array.isArray(token.tokens)) {
      collectIncludePathsFromTokens(token.tokens as Token[], out)
    }
    if (token.type === 'list') {
      const listToken = token as Tokens.List
      for (const item of listToken.items) {
        if (Array.isArray(item.tokens)) {
          collectIncludePathsFromTokens(item.tokens, out)
        }
      }
    }
  }
}

function parseFrontmatterPaths(rawContent: string): {
  body: string
  globs: string[] | undefined
  hadFrontmatter: boolean
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  const hadFrontmatter = content !== rawContent
  const rawPaths = frontmatter.paths
  if (rawPaths === undefined || rawPaths === null) {
    return { body: content, globs: undefined, hadFrontmatter }
  }
  const rawList = Array.isArray(rawPaths)
    ? rawPaths.map(item => String(item))
    : [String(rawPaths)]
  const globs: string[] = []
  for (const entry of rawList) {
    for (const split of splitPathInFrontmatter(entry)) {
      const cleaned = split.trim().replace(/\/\*\*$/, '')
      if (cleaned) {
        globs.push(cleaned)
      }
    }
  }
  if (globs.length === 0 || globs.every(g => g === '**')) {
    return { body: content, globs: undefined, hadFrontmatter }
  }
  return { body: content, globs, hadFrontmatter }
}

/**
 * Hard-truncates AutoMem / TeamMem entrypoints at 200 lines and 25KB.
 */
export function truncateEntrypointContent(raw: string): {
  content: string
  truncated: boolean
} {
  const lines = raw.split(/\r?\n/)
  let truncated = false
  let selected = raw

  if (lines.length > MAX_ENTRYPOINT_LINES) {
    selected = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    truncated = true
  }

  if (Buffer.byteLength(selected, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
    let slice = selected.slice(0, MAX_ENTRYPOINT_BYTES)
    while (Buffer.byteLength(slice, 'utf-8') > MAX_ENTRYPOINT_BYTES) {
      slice = slice.slice(0, slice.length - 100)
    }
    const lastNewline = slice.lastIndexOf('\n')
    selected = lastNewline > 0 ? slice.slice(0, lastNewline) : slice
    truncated = true
  }

  if (!truncated) {
    return { content: raw, truncated: false }
  }
  return {
    content: `${selected}\n\n[Truncated: MEMORY.md exceeds ${MAX_ENTRYPOINT_LINES} lines / ${MAX_ENTRYPOINT_BYTES} bytes]`,
    truncated: true,
  }
}

function readSingleMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  parent?: string,
): { file: MemoryFileInfo; resolvedPath: string; tokens: Token[] } | null {
  if (!isAllowedTextExtension(filePath)) {
    return null
  }
  if (isExcludedBySettings(filePath, type)) {
    return null
  }

  const fsImpl = getFsImplementation()
  const { resolvedPath } = safeResolvePath(fsImpl, filePath)
  const normRaw = normalizePathForComparison(filePath)
  const normResolved = normalizePathForComparison(resolvedPath)

  if (processedPaths.has(normRaw) || processedPaths.has(normResolved)) {
    return null
  }

  let rawContent: string
  try {
    rawContent = fsImpl.readFileSync(resolvedPath, { encoding: 'utf-8' })
  } catch {
    return null
  }

  processedPaths.add(normRaw)
  processedPaths.add(normResolved)

  if (type === 'AutoMem' || type === 'TeamMem') {
    const { content, truncated } = truncateEntrypointContent(rawContent)
    return {
      file: {
        path: filePath,
        type,
        content,
        parent,
        ...(truncated ? { contentDiffersFromDisk: true, rawContent } : {}),
      },
      resolvedPath,
      tokens: [],
    }
  }

  const { body, globs, hadFrontmatter } = parseFrontmatterPaths(rawContent)
  const tokens = new Lexer({ gfm: false }).lex(body)
  const { text: strippedText, modified: htmlModified } =
    stripHtmlCommentsFromTokens(body, tokens)
  const contentDiffersFromDisk = hadFrontmatter || htmlModified

  return {
    file: {
      path: filePath,
      type,
      content: strippedText,
      parent,
      ...(globs ? { globs, isConditional: true } : {}),
      ...(contentDiffersFromDisk
        ? { contentDiffersFromDisk: true, rawContent }
        : {}),
    },
    resolvedPath,
    tokens,
  }
}

function processMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth = 0,
  parent?: string,
): MemoryFileInfo[] {
  if (depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  const readResult = readSingleMemoryFile(filePath, type, processedPaths, parent)
  if (!readResult) {
    return []
  }

  // Matches v1 actual insertion order: parent file first, then recursive @includes
  const results: MemoryFileInfo[] = [readResult.file]

  if (type === 'AutoMem' || type === 'TeamMem') {
    return results
  }

  const includeCandidates: string[] = []
  collectIncludePathsFromTokens(readResult.tokens, includeCandidates)

  const parentDir = dirname(readResult.resolvedPath)
  for (const candidate of includeCandidates) {
    const includePath = expandPath(candidate, parentDir)
    const { resolvedPath: resolvedInclude } = safeResolvePath(
      getFsImplementation(),
      includePath,
    )
    const isExternal = !pathInOriginalCwd(resolvedInclude)
    if (isExternal && !includeExternal) {
      continue
    }
    results.push(
      ...processMemoryFile(
        includePath,
        type,
        processedPaths,
        includeExternal,
        depth + 1,
        filePath,
      ),
    )
  }

  return results
}

function collectMarkdownFilesRecursive(
  dirPath: string,
  visitedDirs: Set<string>,
): string[] {
  const fsImpl = getFsImplementation()
  if (!fsImpl.existsSync(dirPath)) {
    return []
  }
  const { resolvedPath } = safeResolvePath(fsImpl, dirPath)
  const normRaw = normalizePathForComparison(dirPath)
  const normResolved = normalizePathForComparison(resolvedPath)
  if (visitedDirs.has(normRaw) || visitedDirs.has(normResolved)) {
    return []
  }
  visitedDirs.add(normRaw)
  visitedDirs.add(normResolved)

  let entries: string[]
  try {
    entries = fsImpl.readdirStringSync(resolvedPath).sort()
  } catch {
    return []
  }

  const files: string[] = []
  for (const entryName of entries) {
    const entryPath = join(dirPath, entryName)
    try {
      const stats = fsImpl.statSync(entryPath)
      if (stats.isDirectory()) {
        files.push(...collectMarkdownFilesRecursive(entryPath, visitedDirs))
      } else if (stats.isFile() && entryName.toLowerCase().endsWith('.md')) {
        files.push(entryPath)
      }
    } catch {
      // Skip unreadable entry
    }
  }
  return files
}

function processMdRules(
  rulesDir: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  conditionalOnly: boolean,
): MemoryFileInfo[] {
  const mdFiles = collectMarkdownFilesRecursive(rulesDir, new Set())
  const results: MemoryFileInfo[] = []
  for (const mdFile of mdFiles) {
    const loaded = processMemoryFile(
      mdFile,
      type,
      processedPaths,
      includeExternal,
      0,
    )
    for (const file of loaded) {
      const isCond = Boolean(file.globs && file.globs.length > 0)
      if (conditionalOnly ? isCond : !isCond) {
        results.push(file)
      }
    }
  }
  return results
}

function processConditionedMdRules(
  rulesDir: string,
  type: MemoryType,
  targetPath: string,
  processedPaths: Set<string>,
  includeExternal: boolean,
): MemoryFileInfo[] {
  const baseDir =
    type === 'Project' ? dirname(dirname(rulesDir)) : getOriginalCwd()
  const relTarget = relative(baseDir, targetPath).replace(/\\/g, '/')
  if (!relTarget || relTarget.startsWith('..') || isAbsolute(relTarget)) {
    return []
  }

  const mdFiles = collectMarkdownFilesRecursive(rulesDir, new Set())
  const matched: MemoryFileInfo[] = []

  for (const mdFile of mdFiles) {
    const norm = normalizePathForComparison(mdFile)
    if (processedPaths.has(norm)) {
      continue
    }
    let rawContent: string
    try {
      rawContent = getFsImplementation().readFileSync(mdFile, {
        encoding: 'utf-8',
      })
    } catch {
      continue
    }
    const { globs } = parseFrontmatterPaths(rawContent)
    if (!globs || globs.length === 0) {
      continue
    }
    const matcher = ignore().add(globs)
    if (matcher.ignores(relTarget)) {
      matched.push(
        ...processMemoryFile(mdFile, type, processedPaths, includeExternal, 0),
      )
    }
  }

  return matched
}

function getAncestorDirectoriesRootFirst(startDir: string): string[] {
  const dirs: string[] = []
  let current = resolve(startDir).normalize('NFC')
  while (true) {
    const parent = resolve(current, '..')
    if (parent === current) {
      // Exclude filesystem root itself
      break
    }
    dirs.push(current)
    current = parent
  }
  return dirs.reverse()
}

/**
 * Loads all active memory files (`Managed` < `User` < ancestor `Project`/`Local`
 * < `--add-dir` < `AutoMem` < `TeamMem`) in ascending precedence order.
 */
export const getMemoryFiles = memoize(
  async (forceIncludeExternal = false): Promise<MemoryFileInfo[]> => {
    const results: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()
    const globalConfig = getGlobalConfig()
    const includeExternal =
      forceIncludeExternal ||
      Boolean(globalConfig.projects?.[getOriginalCwd()]?.hasClaudeMdExternalIncludesApproved)

    // 1. Managed (always loaded, immune to claudeMdExcludes)
    results.push(
      ...processMemoryFile(
        getMemoryPath('Managed'),
        'Managed',
        processedPaths,
        includeExternal,
      ),
    )
    results.push(
      ...processMdRules(
        getManagedClaudeRulesDir(),
        'Managed',
        processedPaths,
        includeExternal,
        false,
      ),
    )

    // 2. User (includeExternal always true)
    if (isSettingSourceEnabled('userSettings')) {
      results.push(
        ...processMemoryFile(
          getMemoryPath('User'),
          'User',
          processedPaths,
          true,
        ),
      )
      results.push(
        ...processMdRules(
          getUserClaudeRulesDir(),
          'User',
          processedPaths,
          true,
          false,
        ),
      )
    }

    // 3. Project & Local ancestor walk (root -> originalCwd)
    const originalCwd = getOriginalCwd()
    const gitRoot = findGitRoot(originalCwd)
    const canonicalRoot = findCanonicalGitRoot(originalCwd)
    const isNestedWorktree =
      gitRoot !== null &&
      canonicalRoot !== null &&
      gitRoot !== canonicalRoot &&
      pathIsInside(gitRoot, canonicalRoot)

    const ancestors = getAncestorDirectoriesRootFirst(originalCwd)
    const loadProject = isSettingSourceEnabled('projectSettings')
    const loadLocal = isSettingSourceEnabled('localSettings')

    for (const dir of ancestors) {
      const skipProject =
        isNestedWorktree &&
        canonicalRoot !== null &&
        gitRoot !== null &&
        pathIsInside(dir, canonicalRoot) &&
        !pathIsInside(dir, gitRoot)

      if (loadProject && !skipProject) {
        results.push(
          ...processMemoryFile(
            join(dir, 'INSTRUCTIONS.md'),
            'Project',
            processedPaths,
            includeExternal,
          ),
        )
        results.push(
          ...processMemoryFile(
            join(dir, '.copilot', 'INSTRUCTIONS.md'),
            'Project',
            processedPaths,
            includeExternal,
          ),
        )
        results.push(
          ...processMdRules(
            join(dir, '.copilot', 'rules'),
            'Project',
            processedPaths,
            includeExternal,
            false,
          ),
        )
      }

      if (loadLocal) {
        results.push(
          ...processMemoryFile(
            join(dir, 'INSTRUCTIONS.local.md'),
            'Local',
            processedPaths,
            includeExternal,
          ),
        )
      }
    }

    // 4. Additional directories (--add-dir) when explicitly enabled
    if (isEnvTruthy(process.env.COPILOT_CLI_ADDITIONAL_DIRECTORIES_CLAUDE_MD)) {
      for (const extraDir of getAdditionalDirectoriesForClaudeMd()) {
        results.push(
          ...processMemoryFile(
            join(extraDir, 'INSTRUCTIONS.md'),
            'Project',
            processedPaths,
            includeExternal,
          ),
        )
        results.push(
          ...processMemoryFile(
            join(extraDir, '.copilot', 'INSTRUCTIONS.md'),
            'Project',
            processedPaths,
            includeExternal,
          ),
        )
        results.push(
          ...processMdRules(
            join(extraDir, '.copilot', 'rules'),
            'Project',
            processedPaths,
            includeExternal,
            false,
          ),
        )
      }
    }

    // 5. AutoMem
    const autoMemPath = autoMemEntrypointGetter?.()
    if (autoMemPath) {
      results.push(
        ...processMemoryFile(autoMemPath, 'AutoMem', processedPaths, false),
      )
    }

    // 6. TeamMem
    if (isFeatureEnabled('TEAMMEM')) {
      const teamMemPath = teamMemEntrypointGetter?.()
      if (teamMemPath) {
        results.push(
          ...processMemoryFile(teamMemPath, 'TeamMem', processedPaths, false),
        )
      }
    }

    return results
  },
  (forceIncludeExternal = false) => String(forceIncludeExternal),
)

/**
 * Loads nested subdirectory `INSTRUCTIONS.md` files and matching conditional rules
 * when a file in `dir` is accessed.
 */
export function getMemoryFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
  includeExternal = false,
): MemoryFileInfo[] {
  const results: MemoryFileInfo[] = []
  const unconditionalProcessed = new Set(processedPaths)

  results.push(
    ...processMemoryFile(
      join(dir, 'INSTRUCTIONS.md'),
      'Project',
      unconditionalProcessed,
      includeExternal,
    ),
  )
  results.push(
    ...processMemoryFile(
      join(dir, '.copilot', 'INSTRUCTIONS.md'),
      'Project',
      unconditionalProcessed,
      includeExternal,
    ),
  )
  results.push(
    ...processMemoryFile(
      join(dir, 'INSTRUCTIONS.local.md'),
      'Local',
      unconditionalProcessed,
      includeExternal,
    ),
  )
  results.push(
    ...processMdRules(
      join(dir, '.copilot', 'rules'),
      'Project',
      unconditionalProcessed,
      includeExternal,
      false,
    ),
  )

  const conditional = processConditionedMdRules(
    join(dir, '.copilot', 'rules'),
    'Project',
    targetPath,
    processedPaths,
    includeExternal,
  )

  for (const pathKey of unconditionalProcessed) {
    processedPaths.add(pathKey)
  }

  return [...results, ...conditional]
}

/**
 * Evaluates conditional `.copilot/rules/*.md` for a CWD-level directory.
 */
export function getConditionalRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
  includeExternal = false,
): MemoryFileInfo[] {
  return processConditionedMdRules(
    join(dir, '.copilot', 'rules'),
    'Project',
    targetPath,
    processedPaths,
    includeExternal,
  )
}

/**
 * Evaluates managed and user conditional rules matching `targetPath`.
 */
export function getManagedAndUserConditionalRules(
  targetPath: string,
  processedPaths: Set<string>,
  includeExternal = false,
): MemoryFileInfo[] {
  const results: MemoryFileInfo[] = []
  results.push(
    ...processConditionedMdRules(
      getManagedClaudeRulesDir(),
      'Managed',
      targetPath,
      processedPaths,
      includeExternal,
    ),
  )
  if (isSettingSourceEnabled('userSettings')) {
    results.push(
      ...processConditionedMdRules(
        getUserClaudeRulesDir(),
        'User',
        targetPath,
        processedPaths,
        true,
      ),
    )
  }
  return results
}

/**
 * Returns non-User `@include` entries that resolved outside the project root.
 */
export function getExternalClaudeMdIncludes(
  files: readonly MemoryFileInfo[],
): Array<{ path: string; parent: string }> {
  return files
    .filter(
      file =>
        file.type !== 'User' &&
        Boolean(file.parent) &&
        !pathInOriginalCwd(file.path),
    )
    .map(file => ({ path: file.path, parent: file.parent! }))
}

/**
 * Returns memory files exceeding the `40,000`-char soft warning threshold.
 */
export function getLargeMemoryFiles(
  files: readonly MemoryFileInfo[],
): MemoryFileInfo[] {
  return files.filter(file => file.content.length > MAX_MEMORY_CHARACTER_COUNT)
}

/**
 * Filters out AutoMem/TeamMem entries when dynamic memory surfacing is active.
 */
export function filterInjectedMemoryFiles(
  files: readonly MemoryFileInfo[],
): MemoryFileInfo[] {
  if (getFeatureValueCachedMayBeStale('tengu_moth_copse', false)) {
    return files.filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
  }
  return [...files]
}

/**
 * Formats loaded memory files into the `<system-reminder>` `claudeMd` block.
 */
export function getClaudeMds(
  memoryFiles: readonly MemoryFileInfo[],
  filter?: (file: MemoryFileInfo) => boolean,
): string {
  const filtered = memoryFiles.filter(
    file => file.content.trim().length > 0 && (filter ? filter(file) : true),
  )
  if (filtered.length === 0) {
    return ''
  }

  const sections = filtered.map(file => {
    const description =
      file.type === 'User'
        ? " (user's private global instructions for all projects)"
        : file.type === 'Local'
          ? " (user's private project instructions, not checked in to git)"
          : file.type === 'Project'
            ? ' (project instructions, checked into the codebase)'
            : ''
    const body =
      file.type === 'TeamMem'
        ? `<team-memory-content source="shared">\n${file.content}\n</team-memory-content>`
        : file.content
    return `Contents of ${file.path}${description}:\n\n${body}`
  })

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${sections.join('\n\n')}`
}

/**
 * Clears cached `getMemoryFiles` results silently.
 */
export function clearMemoryFileCaches(): void {
  getMemoryFiles.cache.clear?.()
}

/**
 * Resets cached memory files (invoked on session start / compact).
 */
export function resetGetMemoryFilesCache(
  _reason: 'session_start' | 'compact' = 'session_start',
): void {
  clearMemoryFileCaches()
}
