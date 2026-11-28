/**
 * PID-based consolidation lock (`.consolidate-lock`) for `autoDream`:
 * - File `mtime` IS `lastConsolidatedAt` (single `stat()` per turn)
 * - File body IS the holder's `process.pid`
 * - 1-hour PID-reuse staleness window (`HOLDER_STALE_MS`), race verification,
 *   and rollback restoring prior mtime on failure/abort
 */

import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import {
  getProjectDir,
  listCandidates,
} from '../../utilities/session_storage.js'

export const CONSOLIDATE_LOCK_FILENAME = '.consolidate-lock'
export const HOLDER_STALE_MS = 60 * 60 * 1000

export function getConsolidationLockPath(
  memoryDir: string = getAutoMemPath(),
): string {
  return join(memoryDir, CONSOLIDATE_LOCK_FILENAME)
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    // EPERM means process exists but owned by another user
    return code === 'EPERM'
  }
}

/**
 * Returns the mtime (epoch ms) of `.consolidate-lock`, or `0` if absent.
 */
export async function readLastConsolidatedAt(
  memoryDir: string = getAutoMemPath(),
): Promise<number> {
  try {
    const st = await stat(getConsolidationLockPath(memoryDir))
    return st.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Attempts to acquire the PID lock for memory consolidation.
 * Returns `priorMtime` (`>= 0`) for rollback on success, or `null` if another
 * live process holds a fresh lock (< 1 hour old) or won the write race.
 */
export async function tryAcquireConsolidationLock(
  memoryDir: string = getAutoMemPath(),
): Promise<number | null> {
  const lockPath = getConsolidationLockPath(memoryDir)
  let priorMtime = 0

  try {
    const [st, rawBody] = await Promise.all([
      stat(lockPath),
      readFile(lockPath, 'utf8'),
    ])
    priorMtime = st.mtimeMs
    const holderPid = Number.parseInt(rawBody.trim(), 10)
    const lockAgeMs = Date.now() - st.mtimeMs
    if (
      lockAgeMs < HOLDER_STALE_MS &&
      Number.isFinite(holderPid) &&
      holderPid > 0 &&
      isProcessRunning(holderPid)
    ) {
      return null
    }
  } catch {
    // Lock file absent or unreadable; proceed to acquire
  }

  await mkdir(memoryDir, { recursive: true, mode: 0o700 })
  await writeFile(lockPath, String(process.pid), {
    encoding: 'utf8',
    mode: 0o600,
  })

  // Re-read to verify we won any concurrent write race
  try {
    const verify = Number.parseInt(
      (await readFile(lockPath, 'utf8')).trim(),
      10,
    )
    if (verify !== process.pid) {
      return null
    }
  } catch {
    return null
  }

  return priorMtime
}

/**
 * Releases the consolidation lock and restores `priorMtime` (or deletes the
 * lock file when `priorMtime === 0`).
 */
export async function rollbackConsolidationLock(
  priorMtime: number,
  memoryDir: string = getAutoMemPath(),
): Promise<void> {
  const lockPath = getConsolidationLockPath(memoryDir)
  if (priorMtime <= 0) {
    await unlink(lockPath).catch(() => {})
    return
  }
  await writeFile(lockPath, '', { encoding: 'utf8', mode: 0o600 }).catch(() => {})
  const sec = priorMtime / 1000
  await utimes(lockPath, sec, sec).catch(() => {})
}

/**
 * Optimistically stamps `.consolidate-lock` for manual `/dream` invocations.
 */
export async function recordConsolidation(
  memoryDir: string = getAutoMemPath(),
): Promise<void> {
  await mkdir(memoryDir, { recursive: true, mode: 0o700 })
  await writeFile(getConsolidationLockPath(memoryDir), String(process.pid), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/**
 * Lists main-session IDs (excluding `agent-*.jsonl`) whose JSONL transcripts
 * have been modified strictly after `sinceMs`.
 */
export async function listSessionsTouchedSince(
  sinceMs: number,
  projectDir: string = getProjectDir(getOriginalCwd()),
): Promise<string[]> {
  const candidates = await listCandidates(projectDir, true)
  return candidates
    .filter(c => c.mtime > sinceMs)
    .map(c => String(c.sessionId))
}
