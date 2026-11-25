import { homedir } from 'os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { getCwd } from './cwd.js'
import { getFsImplementation } from './fs_operations.js'
import { djb2Hash } from './hash.js'
import { getPlatform } from './platform.js'
import { posixPathToWindowsPath } from './windows_paths.js'

export const MAX_SANITIZED_LENGTH = 200

/**
 * Expands a path that may contain tilde notation (~) to an absolute path.
 * On Windows, POSIX-style paths (e.g., `/c/Users/...`) are converted to Windows format.
 */
export function expandPath(targetPath: string, baseDir?: string): string {
  const actualBaseDir = baseDir ?? getCwd() ?? getFsImplementation().cwd()

  if (typeof targetPath !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof targetPath}`)
  }

  if (typeof actualBaseDir !== 'string') {
    throw new TypeError(
      `Base directory must be a string, received ${typeof actualBaseDir}`,
    )
  }

  if (targetPath.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  const trimmedPath = targetPath.trim()
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize('NFC')
  }

  if (trimmedPath === '~') {
    return homedir().normalize('NFC')
  }

  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  }

  let processedPath = trimmedPath
  if (getPlatform() === 'windows' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath)
    } catch {
      processedPath = trimmedPath
    }
  }

  if (isAbsolute(processedPath)) {
    return normalize(processedPath).normalize('NFC')
  }

  return resolve(actualBaseDir, processedPath).normalize('NFC')
}

/**
 * Converts an absolute path to a relative path from cwd if under cwd,
 * otherwise returns the absolute path unchanged.
 */
export function toRelativePath(absolutePath: string): string {
  const relativePath = relative(getCwd(), absolutePath)
  return relativePath.startsWith('..') ? absolutePath : relativePath
}

/**
 * Gets the directory path for a given file or directory path.
 */
export function getDirectoryForPath(targetPath: string): string {
  const absolutePath = expandPath(targetPath)
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return dirname(absolutePath)
  }
  try {
    const stats = getFsImplementation().statSync(absolutePath)
    if (stats.isDirectory()) {
      return absolutePath
    }
  } catch {
    // Path does not exist or cannot be accessed
  }
  return dirname(absolutePath)
}

/**
 * Checks whether a path contains directory traversal patterns (`..`).
 */
export function containsPathTraversal(targetPath: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(targetPath)
}

function simpleHash(input: string): string {
  return Math.abs(djb2Hash(input)).toString(36)
}

/**
 * Makes a string safe for use as a directory or file name across all platforms.
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  const hash =
    typeof Bun !== 'undefined' ? Bun.hash(name).toString(36) : simpleHash(name)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

/**
 * Normalizes a path for use as a JSON config key using forward slashes.
 */
export function normalizePathForConfigKey(targetPath: string): string {
  const normalized = normalize(targetPath)
  return normalized.replace(/\\/g, '/')
}
