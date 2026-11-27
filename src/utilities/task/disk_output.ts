/**
 * Symlink-safe disk-backed task output file management (`O_NOFOLLOW | O_EXCL`
 * on POSIX, exclusive `'wx'` creation on Windows, `0o600` permissions, and a
 * 5 GB hard size ceiling).
 */

import { randomBytes } from 'crypto'
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getPlatform } from '../platform.js'

export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

/**
 * Generates a short random task ID for background or streamed shell tasks.
 */
export function generateTaskId(prefix = 'b'): string {
  return `${prefix}${randomBytes(4).toString('hex')}`
}

/**
 * Returns the directory storing task output files for the active session.
 */
export function getTaskOutputDir(): string {
  return join(tmpdir(), 'copilot-cli-tasks', getSessionId())
}

/**
 * Returns the output file path for `taskId`.
 */
export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}

/**
 * Opens a brand-new task output file with symlink-safe exclusive flags
 * (`O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW` on POSIX, `'wx+'` on Windows).
 */
export function createTaskOutputFile(taskId: string): {
  fd: number
  path: string
} {
  const dir = getTaskOutputDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const outputPath = getTaskOutputPath(taskId)

  const flags =
    getPlatform() === 'windows'
      ? fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR
      : fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_RDWR |
        (fsConstants.O_NOFOLLOW ?? 0)

  const fd = openSync(outputPath, flags, 0o600)
  return { fd, path: outputPath }
}

/**
 * Safely inspects current disk output file byte size (returning 0 on error).
 */
export function getTaskOutputSize(outputPath: string): number {
  try {
    return statSync(outputPath).size
  } catch {
    return 0
  }
}

/**
 * Closes a task output FD safely (idempotent).
 */
export function closeTaskOutputFd(fd: number | undefined): void {
  if (fd === undefined) return
  try {
    closeSync(fd)
  } catch {
    // Already closed
  }
}

/**
 * Removes a temporary task output file when no longer needed.
 */
export function removeTaskOutputFile(outputPath: string): void {
  try {
    unlinkSync(outputPath)
  } catch {
    // Ignore missing file
  }
}
