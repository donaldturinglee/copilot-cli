/**
 * Glob file finder built atop `ripGrep(['--files', ...])`, supporting base
 * directory extraction, VCS & permission ignore exclusions, mtime sorting,
 * and truncation limits.
 */

import { statSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { isEnvTruthy } from './env_utils.js'
import { ripGrep } from './ripgrep.js'

const GLOB_META_REGEX = /[*?[\]{}()!]/

export const VCS_EXCLUDE_GLOBS = [
  '!.git/**',
  '!.svn/**',
  '!.hg/**',
  '!.bzr/**',
  '!.jj/**',
  '!.sl/**',
] as const

/**
 * Extracts a static directory prefix from a glob pattern to narrow traversal
 * (e.g. `src/tools/**\/*.ts` -> `{ baseDir: 'src/tools', pattern: '**\/*.ts' }`).
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string | null
  pattern: string
} {
  const normalized = pattern.replace(/\\/g, '/')
  const parts = normalized.split('/')
  const staticParts: string[] = []

  for (const part of parts) {
    if (GLOB_META_REGEX.test(part)) {
      break
    }
    staticParts.push(part)
  }

  if (staticParts.length === 0) {
    return { baseDir: null, pattern: normalized }
  }

  // If the entire pattern had no glob characters, keep filename in pattern
  if (staticParts.length === parts.length) {
    staticParts.pop()
  }

  if (staticParts.length === 0) {
    return { baseDir: null, pattern: normalized }
  }

  const baseDir = staticParts.join('/')
  const rest = parts.slice(staticParts.length).join('/')
  return {
    baseDir,
    pattern: rest || '*',
  }
}

export interface GlobOptions {
  limit?: number
  offset?: number
  ignorePatterns?: readonly string[]
  noIgnore?: boolean
  includeHidden?: boolean
  timeoutMs?: number
  forceFallback?: boolean
}

export interface GlobResult {
  files: string[]
  truncated: boolean
}

function getGlobTimeoutMs(override?: number): number {
  if (override !== undefined) return override
  const envSec = Number(process.env.COPILOT_CLI_GLOB_TIMEOUT_SECONDS)
  if (!Number.isNaN(envSec) && envSec > 0) {
    return envSec * 1000
  }
  return 20_000
}

/**
 * Finds files matching `pattern` under `searchPath`, sorted by modification
 * time descending and capped at `options.limit` (default 100).
 */
export async function glob(
  pattern: string,
  searchPath: string,
  options: GlobOptions = {},
  abortSignal: AbortSignal = new AbortController().signal,
): Promise<GlobResult> {
  const limit = options.limit ?? 100
  const offset = options.offset ?? 0
  const noIgnore =
    options.noIgnore ?? isEnvTruthy(process.env.COPILOT_CLI_GLOB_NO_IGNORE)
  const includeHidden =
    options.includeHidden ??
    isEnvTruthy(process.env.COPILOT_CLI_GLOB_HIDDEN)

  let effectiveRoot = resolve(searchPath)
  let effectivePattern = pattern

  const extracted = extractGlobBaseDirectory(pattern)
  if (extracted.baseDir) {
    const candidateDir = isAbsolute(extracted.baseDir)
      ? extracted.baseDir
      : join(effectiveRoot, extracted.baseDir)
    try {
      if (statSync(candidateDir).isDirectory()) {
        effectiveRoot = candidateDir
        effectivePattern = extracted.pattern
      }
    } catch {
      // Keep original root and full pattern
    }
  }

  const args: string[] = ['--files', '--sort=modified']
  if (noIgnore) {
    args.push('--no-ignore')
  }
  if (includeHidden) {
    args.push('--hidden')
  }
  for (const vcs of VCS_EXCLUDE_GLOBS) {
    args.push('--glob', vcs)
  }
  if (options.ignorePatterns) {
    for (const pat of options.ignorePatterns) {
      const cleaned = pat.startsWith('!') ? pat : `!${pat}`
      args.push('--glob', cleaned)
    }
  }
  args.push('--glob', effectivePattern)

  const allMatches = await ripGrep(args, effectiveRoot, abortSignal, {
    timeoutMs: getGlobTimeoutMs(options.timeoutMs),
    maxLines: offset + limit + 1,
    forceFallback: options.forceFallback,
  })

  const sliced = allMatches.slice(offset, offset + limit)
  const truncated = allMatches.length > offset + limit

  // Convert paths returned relative to effectiveRoot into absolute paths if needed
  const absoluteFiles = sliced.map(file =>
    isAbsolute(file) ? file : resolve(effectiveRoot, file),
  )

  return {
    files: absoluteFiles,
    truncated,
  }
}

/**
 * Formats an absolute file path relative to `baseDir` if inside it.
 */
export function formatGlobResultPath(filePath: string, baseDir: string): string {
  const rel = relative(baseDir, filePath)
  return rel && !rel.startsWith('..') ? rel : filePath
}
