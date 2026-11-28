/**
 * Team memory path resolution and symlink/traversal security validation
 * (`src/memdir/team_mem_paths.ts`).
 */

import { lstat, realpath } from 'fs/promises'
import { dirname, join, normalize, resolve, sep } from 'path'
import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from '../utilities/env_utils.js'
import { getErrnoCode } from '../utilities/errors.js'
import {
  AUTO_MEM_ENTRYPOINT_NAME,
  getAutoMemPath,
  isAutoMemoryEnabled,
} from './paths.js'

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

/**
 * Returns whether team memory is enabled for the active session.
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_ENABLE_TEAM_MEMORY)) {
    return true
  }
  return getFeatureValueCachedMayBeStale('tengu_herring_clock', false)
}

/**
 * Returns the team memory subdirectory (`<autoMemPath>/team/`).
 */
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

export function getTeamMemEntrypoint(): string {
  return join(getTeamMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * String-level check whether `filePath` lies inside `getTeamMemPath()`.
 */
export function isTeamMemPath(filePath: string): boolean {
  const normTarget = normalize(resolve(filePath)).normalize('NFC')
  const normBase = normalize(getTeamMemPath()).normalize('NFC')
  if (process.platform === 'win32') {
    return normTarget.toLowerCase().startsWith(normBase.toLowerCase())
  }
  return normTarget.startsWith(normBase)
}

export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}

/**
 * Sanitizes a server-supplied relative team memory key, rejecting null bytes,
 * backslashes, leading slashes, URL-encoded `..`/`/`, and Unicode NFKC
 * fullwidth traversal bypasses.
 */
export function sanitizePathKey(key: string): string {
  if (!key || key.includes('\0') || key.includes('\\') || key.startsWith('/')) {
    throw new PathTraversalError(`Invalid team memory key: ${key}`)
  }

  let decoded = key
  try {
    decoded = decodeURIComponent(key)
  } catch {
    throw new PathTraversalError(`Malformed URI encoding in team memory key: ${key}`)
  }

  const nfkc = decoded.normalize('NFKC')
  for (const variant of [key, decoded, nfkc]) {
    if (
      variant.includes('\0') ||
      variant.includes('\\') ||
      variant.startsWith('/') ||
      variant.split('/').some(seg => seg === '..' || seg === '.')
    ) {
      throw new PathTraversalError(`Path traversal detected in key: ${key}`)
    }
  }

  return key
}

async function realpathDeepestExisting(absolutePath: string): Promise<string> {
  const popped: string[] = []
  let cursor = resolve(absolutePath)

  while (true) {
    try {
      const resolved = await realpath(cursor)
      return popped.length > 0 ? join(resolved, ...popped.reverse()) : resolved
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ELOOP') {
        throw new PathTraversalError(`Symlink loop detected at ${cursor}`)
      }
      if (code === 'ENOENT') {
        // Distinguish dangling symlink from genuinely missing file
        try {
          const lst = await lstat(cursor)
          if (lst.isSymbolicLink()) {
            throw new PathTraversalError(
              `Dangling symlink rejected at ${cursor}`,
            )
          }
        } catch (lstatErr) {
          if (lstatErr instanceof PathTraversalError) {
            throw lstatErr
          }
        }
        const parent = dirname(cursor)
        if (parent === cursor) {
          return resolve(absolutePath)
        }
        popped.push(cursor.slice(parent.length).replace(/^[\\/]+/, ''))
        cursor = parent
        continue
      }
      if (code === 'ENOTDIR' || code === 'ENAMETOOLONG') {
        const parent = dirname(cursor)
        if (parent === cursor) {
          throw new PathTraversalError(`Unresolvable path: ${absolutePath}`)
        }
        popped.push(cursor.slice(parent.length).replace(/^[\\/]+/, ''))
        cursor = parent
        continue
      }
      // Fail closed on unexpected filesystem errors
      throw new PathTraversalError(
        `Unable to verify symlink containment for ${absolutePath}: ${String(error)}`,
      )
    }
  }
}

async function isRealPathWithinTeamDir(realCandidate: string): Promise<boolean> {
  const teamDir = getTeamMemPath().replace(/[\\/]+$/, '')
  let realTeamDir: string
  try {
    realTeamDir = await realpath(teamDir)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return isTeamMemPath(realCandidate)
    }
    return false
  }

  const candNorm = normalize(realCandidate).normalize('NFC')
  const baseNorm = normalize(realTeamDir).normalize('NFC')
  if (process.platform === 'win32') {
    const c = candNorm.toLowerCase()
    const b = baseNorm.toLowerCase()
    return c === b || c.startsWith(`${b}${sep}`)
  }
  return candNorm === baseNorm || candNorm.startsWith(`${baseNorm}${sep}`)
}

/**
 * Validates that a local write target lies strictly within the team memory
 * directory even after resolving symlinks.
 */
export async function validateTeamMemWritePath(
  filePath: string,
): Promise<string> {
  if (!filePath || filePath.includes('\0')) {
    throw new PathTraversalError('Null byte or empty team memory write path')
  }
  const resolved = resolve(filePath)
  if (!isTeamMemPath(resolved)) {
    throw new PathTraversalError(
      `Write target outside team memory directory: ${filePath}`,
    )
  }
  const realCandidate = await realpathDeepestExisting(resolved)
  if (!(await isRealPathWithinTeamDir(realCandidate))) {
    throw new PathTraversalError(
      `Symlink escape outside team memory directory: ${filePath}`,
    )
  }
  return resolved
}

/**
 * Validates a relative remote team-memory key and returns its safe local path.
 */
export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  const cleanKey = sanitizePathKey(relativeKey)
  const candidate = join(getTeamMemPath(), cleanKey)
  return validateTeamMemWritePath(candidate)
}
