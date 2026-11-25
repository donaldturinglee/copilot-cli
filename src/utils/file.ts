import { chmodSync, writeFileSync as fsWriteFileSync } from 'fs'
import { realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'path'
import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnoent, isFsInaccessible } from './errors.js'
import {
  detectEncodingForResolvedPath,
  detectLineEndingsForString,
  type LineEndingType,
} from './file_read.js'
import { fileReadCache } from './file_read_cache.js'
import { getFsImplementation, safeResolvePath } from './fs_operations.js'
import { logError } from './log.js'
import { expandPath } from './path.js'
import { getPlatform } from './platform.js'

export type FileRecord = {
  filename: string
  content: string
}

export const MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024
export const FILE_NOT_FOUND_CWD_NOTE = 'Note: your current working directory is'

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

export function readFileSafe(filepath: string): string | null {
  try {
    const fsImpl = getFsImplementation()
    return fsImpl.readFileSync(filepath, { encoding: 'utf8' })
  } catch (error) {
    logError(error)
    return null
  }
}

export function getFileModificationTime(filePath: string): number {
  const fsImpl = getFsImplementation()
  return Math.floor(fsImpl.statSync(filePath).mtimeMs)
}

export async function getFileModificationTimeAsync(
  filePath: string,
): Promise<number> {
  const stats = await getFsImplementation().stat(filePath)
  return Math.floor(stats.mtimeMs)
}

export function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
): void {
  let toWrite = content
  if (endings === 'CRLF') {
    toWrite = content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
  }

  writeFileSyncAndFlushDeprecated(filePath, toWrite, { encoding })
}

export function detectFileEncoding(filePath: string): BufferEncoding {
  try {
    const fsImpl = getFsImplementation()
    const { resolvedPath } = safeResolvePath(fsImpl, filePath)
    return detectEncodingForResolvedPath(resolvedPath)
  } catch (error) {
    if (isFsInaccessible(error)) {
      logForDebugging(
        `detectFileEncoding failed for expected reason: ${error.code}`,
        { level: 'debug' },
      )
    } else {
      logError(error)
    }
    return 'utf8'
  }
}

export function detectLineEndings(
  filePath: string,
  encoding: BufferEncoding = 'utf8',
): LineEndingType {
  try {
    const fsImpl = getFsImplementation()
    const { resolvedPath } = safeResolvePath(fsImpl, filePath)
    const { buffer, bytesRead } = fsImpl.readSync(resolvedPath, {
      length: 4096,
    })
    const content = buffer.toString(encoding, 0, bytesRead)
    return detectLineEndingsForString(content)
  } catch (error) {
    logError(error)
    return 'LF'
  }
}

export function convertLeadingTabsToSpaces(content: string): string {
  if (!content.includes('\t')) return content
  return content.replace(/^\t+/gm, match => '  '.repeat(match.length))
}

export function getAbsoluteAndRelativePaths(targetPath: string | undefined): {
  absolutePath: string | undefined
  relativePath: string | undefined
} {
  const absolutePath = targetPath ? expandPath(targetPath) : undefined
  const relativePath = absolutePath
    ? relative(getCwd(), absolutePath)
    : undefined
  return { absolutePath, relativePath }
}

export function getDisplayPath(filePath: string): string {
  const { relativePath } = getAbsoluteAndRelativePaths(filePath)
  if (relativePath && !relativePath.startsWith('..')) {
    return relativePath
  }

  const homeDir = homedir()
  if (filePath.startsWith(homeDir + sep)) {
    return '~' + filePath.slice(homeDir.length)
  }

  return filePath
}

export function findSimilarFile(filePath: string): string | undefined {
  const fsImpl = getFsImplementation()
  try {
    const dir = dirname(filePath)
    const fileBaseName = basename(filePath, extname(filePath))
    const files = fsImpl.readdirSync(dir)

    const similarFiles = files.filter(
      file =>
        basename(file.name, extname(file.name)) === fileBaseName &&
        join(dir, file.name) !== filePath,
    )

    const firstMatch = similarFiles[0]
    return firstMatch ? firstMatch.name : undefined
  } catch (error) {
    if (!isEnoent(error)) {
      logError(error)
    }
    return undefined
  }
}

export async function suggestPathUnderCwd(
  requestedPath: string,
): Promise<string | undefined> {
  const cwd = getCwd()
  const cwdParent = dirname(cwd)

  let resolvedPath = requestedPath
  try {
    const resolvedDir = await realpath(dirname(requestedPath))
    resolvedPath = join(resolvedDir, basename(requestedPath))
  } catch {
    // Parent directory does not exist
  }

  const cwdParentPrefix = cwdParent === sep ? sep : cwdParent + sep
  if (
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(cwd + sep) ||
    resolvedPath === cwd
  ) {
    return undefined
  }

  const relFromParent = relative(cwdParent, resolvedPath)
  const correctedPath = join(cwd, relFromParent)
  try {
    await stat(correctedPath)
    return correctedPath
  } catch {
    return undefined
  }
}

export function isCompactLinePrefixEnabled(): boolean {
  return !getFeatureValueCachedMayBeStale(
    'tengu_compact_line_prefix_killswitch',
    false,
  )
}

export function addLineNumbers({
  content,
  startLine,
}: {
  content: string
  startLine: number
}): string {
  if (!content) {
    return ''
  }

  const lines = content.split(/\r?\n/)

  if (isCompactLinePrefixEnabled()) {
    return lines
      .map((line, index) => `${index + startLine}\t${line}`)
      .join('\n')
  }

  return lines
    .map((line, index) => {
      const numStr = String(index + startLine)
      if (numStr.length >= 6) {
        return `${numStr}→${line}`
      }
      return `${numStr.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}

export function stripLineNumberPrefix(line: string): string {
  const match = line.match(/^\s*\d+[\u2192\t](.*)$/)
  return match?.[1] ?? line
}

export function isDirEmpty(dirPath: string): boolean {
  try {
    return getFsImplementation().isDirEmptySync(dirPath)
  } catch (error) {
    return isEnoent(error)
  }
}

export function readFileSyncCached(filePath: string): string {
  const { content } = fileReadCache.readFile(filePath)
  return content
}

/**
 * Atomically writes and flushes a file to disk via temp file + rename,
 * preserving symlinks and permissions.
 *
 * @deprecated Use async fs.promises writes when possible.
 */
export function writeFileSyncAndFlushDeprecated(
  filePath: string,
  content: string,
  options: { encoding: BufferEncoding; mode?: number } = { encoding: 'utf-8' },
): void {
  const fsImpl = getFsImplementation()

  let targetPath = filePath
  try {
    const linkTarget = fsImpl.readlinkSync(filePath)
    targetPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget)
    logForDebugging(`Writing through symlink: ${filePath} -> ${targetPath}`)
  } catch {
    // Not a symlink or does not exist
  }

  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

  let targetMode: number | undefined
  let targetExists = false
  try {
    targetMode = fsImpl.statSync(targetPath).mode
    targetExists = true
  } catch (error) {
    if (!isEnoent(error)) throw error
    if (options.mode !== undefined) {
      targetMode = options.mode
    }
  }

  try {
    const writeOptions: {
      encoding: BufferEncoding
      flush: boolean
      mode?: number
    } = {
      encoding: options.encoding,
      flush: true,
    }
    if (!targetExists && options.mode !== undefined) {
      writeOptions.mode = options.mode
    }

    fsWriteFileSync(tempPath, content, writeOptions)

    if (targetExists && targetMode !== undefined) {
      chmodSync(tempPath, targetMode)
    }

    fsImpl.renameSync(tempPath, targetPath)
  } catch (atomicError) {
    logForDebugging(`Failed to write file atomically: ${atomicError}`, {
      level: 'error',
    })
    logEvent('tengu_atomic_write_error', {})

    try {
      fsImpl.unlinkSync(tempPath)
    } catch {
      // Ignore temp cleanup failures
    }

    const fallbackOptions: {
      encoding: BufferEncoding
      flush: boolean
      mode?: number
    } = {
      encoding: options.encoding,
      flush: true,
    }
    if (!targetExists && options.mode !== undefined) {
      fallbackOptions.mode = options.mode
    }

    fsWriteFileSync(targetPath, content, fallbackOptions)
  }
}

export function getDesktopPath(): string {
  const platform = getPlatform()
  const homeDir = homedir()

  if (platform === 'macos') {
    return join(homeDir, 'Desktop')
  }

  if (platform === 'windows') {
    const windowsHome = process.env.USERPROFILE
      ? process.env.USERPROFILE.replace(/\\/g, '/')
      : null

    if (windowsHome) {
      const wslPath = windowsHome.replace(/^[A-Z]:/, '')
      const desktopPath = `/mnt/c${wslPath}/Desktop`
      if (getFsImplementation().existsSync(desktopPath)) {
        return desktopPath
      }
    }

    try {
      const usersDir = '/mnt/c/Users'
      const userDirs = getFsImplementation().readdirSync(usersDir)

      for (const user of userDirs) {
        if (
          user.name === 'Public' ||
          user.name === 'Default' ||
          user.name === 'Default User' ||
          user.name === 'All Users'
        ) {
          continue
        }
        const potentialDesktopPath = join(usersDir, user.name, 'Desktop')
        if (getFsImplementation().existsSync(potentialDesktopPath)) {
          return potentialDesktopPath
        }
      }
    } catch (error) {
      logError(error)
    }
  }

  const desktopPath = join(homeDir, 'Desktop')
  if (getFsImplementation().existsSync(desktopPath)) {
    return desktopPath
  }

  return homeDir
}

export function isFileWithinReadSizeLimit(
  filePath: string,
  maxSizeBytes: number = MAX_OUTPUT_SIZE,
): boolean {
  try {
    const stats = getFsImplementation().statSync(filePath)
    return stats.size <= maxSizeBytes
  } catch {
    return false
  }
}

export function normalizePathForComparison(filePath: string): string {
  let normalized = normalize(filePath)
  if (getPlatform() === 'windows') {
    normalized = normalized.replace(/\//g, '\\').toLowerCase()
  }
  return normalized
}

export function pathsEqual(path1: string, path2: string): boolean {
  return normalizePathForComparison(path1) === normalizePathForComparison(path2)
}
