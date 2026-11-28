/**
 * File history checkpointing and arbitrary-point code rollback
 * (`src/utilities/file_history.ts`):
 * - Automatic pre-edit `v1` backups (`fileHistoryTrackEdit`) including `null`
 *   markers for newly created files so rewinding unlinks them cleanly
 * - Per-turn deduplicated snapshots (`fileHistoryMakeSnapshot`), capped at 100
 *   entries with monotonic `snapshotSequence`
 * - Content-addressed `<sha256_16>@v<n>` storage under
 *   `~/.copilot/file-history/<sessionId>/`
 * - Dry-run diff stats (`fileHistoryGetDiffStats`), fast change detection
 *   (`fileHistoryHasAnyChanges`), exact disk rollback (`fileHistoryRewind`),
 *   resume migration (`copyFileHistoryForResume`), and retention cleanup
 */

import { createHash, type UUID } from 'crypto'
import { diffLines } from 'diff'
import type { Stats } from 'fs'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import {
  getIsNonInteractiveSession,
  getOriginalCwd,
  getSessionId,
} from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import type {
  FileHistoryBackup,
  FileHistorySnapshot,
} from '../types/forward.js'
import type { LogOption } from '../types/logs.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './env_utils.js'
import { getErrnoCode, isEnoent } from './errors.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './session_storage.js'
import { getInitialSettings } from './settings/settings.js'

export type { FileHistoryBackup, FileHistorySnapshot }

export const MAX_SNAPSHOTS = 100
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  snapshotSequence: number
}

export type DiffStats =
  | {
      filesChanged?: string[]
      insertions: number
      deletions: number
    }
  | undefined

export type FileHistoryUpdater = (
  updater: (prev: FileHistoryState) => FileHistoryState,
) => void

export function createEmptyFileHistoryState(): FileHistoryState {
  return {
    snapshots: [],
    trackedFiles: new Set(),
    snapshotSequence: 0,
  }
}

function fileHistoryEnabledSdk(): boolean {
  return (
    isEnvTruthy(process.env.COPILOT_CLI_ENABLE_SDK_FILE_CHECKPOINTING) &&
    !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_FILE_CHECKPOINTING)
  )
}

/**
 * Returns whether file checkpointing is enabled for the active session mode.
 */
export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    return fileHistoryEnabledSdk()
  }
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_FILE_CHECKPOINTING)
  )
}

function maybeShortenFilePath(filePath: string): string {
  const cwd = getOriginalCwd()
  if (cwd && isAbsolute(filePath) && filePath.startsWith(cwd)) {
    return relative(cwd, filePath)
  }
  return filePath
}

function maybeExpandFilePath(trackingPath: string): string {
  if (isAbsolute(trackingPath)) {
    return trackingPath
  }
  return join(getOriginalCwd(), trackingPath)
}

export function getBackupFileName(filePath: string, version: number): string {
  const hash16 = createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16)
  return `${hash16}@v${version}`
}

export function getFileHistoryRootDir(): string {
  return join(getClaudeConfigHomeDir(), 'file-history')
}

export function getFileHistorySessionDir(
  sessionId: string = getSessionId(),
): string {
  return join(getFileHistoryRootDir(), sessionId)
}

export function resolveBackupPath(
  backupFileName: string,
  sessionId: string = getSessionId(),
): string {
  return join(getFileHistorySessionDir(sessionId), backupFileName)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readFileAsyncOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function createBackup(
  filePath: string | null,
  version: number,
): Promise<FileHistoryBackup> {
  if (filePath === null) {
    return {
      backupFileName: null,
      version,
      backupTime: new Date(),
    }
  }

  let srcStats: Stats
  try {
    srcStats = await stat(filePath)
  } catch (error) {
    if (isEnoent(error)) {
      return {
        backupFileName: null,
        version,
        backupTime: new Date(),
      }
    }
    throw error
  }

  const backupFileName = getBackupFileName(filePath, version)
  const backupPath = resolveBackupPath(backupFileName)

  try {
    await copyFile(filePath, backupPath)
  } catch (error) {
    if (isEnoent(error)) {
      await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 })
      await copyFile(filePath, backupPath)
    } else {
      throw error
    }
  }

  try {
    await chmod(backupPath, srcStats.mode)
  } catch {
    // Best-effort mode preservation (Windows/restricted filesystems)
  }

  return {
    backupFileName,
    version,
    backupTime: new Date(),
  }
}

/**
 * Checks whether `originalFile` on disk differs from `backupFileName`.
 */
export async function checkOriginFileChanged(
  originalFile: string,
  backupFileName: string,
  originalStatsHint?: Stats,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName)

  let originalStats: Stats | undefined = originalStatsHint
  let originalMissing = false
  if (!originalStats) {
    try {
      originalStats = await stat(originalFile)
    } catch (error) {
      if (isEnoent(error)) {
        originalMissing = true
      } else {
        return true
      }
    }
  }

  let backupStats: Stats | undefined
  let backupMissing = false
  try {
    backupStats = await stat(backupPath)
  } catch (error) {
    if (isEnoent(error)) {
      backupMissing = true
    } else {
      return true
    }
  }

  if (originalMissing && backupMissing) return false
  if (originalMissing !== backupMissing) return true
  if (!originalStats || !backupStats) return true

  if (
    (process.platform !== 'win32' && originalStats.mode !== backupStats.mode) ||
    originalStats.size !== backupStats.size
  ) {
    return true
  }

  if (originalStats.mtimeMs < backupStats.mtimeMs) {
    return false
  }

  try {
    const [originalContent, backupContent] = await Promise.all([
      readFile(originalFile, 'utf8'),
      readFile(backupPath, 'utf8'),
    ])
    return originalContent !== backupContent
  } catch {
    return true
  }
}

function getBackupFileNameFirstVersion(
  trackingPath: string,
  state: FileHistoryState,
): string | null | undefined {
  for (const snapshot of state.snapshots) {
    const entry = snapshot.trackedFileBackups[trackingPath]
    if (entry && entry.version === 1) {
      return entry.backupFileName
    }
  }
  return undefined
}

async function restoreBackup(
  filePath: string,
  backupFileName: string,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName)
  let backupStats: Stats
  try {
    backupStats = await stat(backupPath)
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_rewind_restore_file_failed', {
      dryRun: false,
    })
    return false
  }

  try {
    await copyFile(backupPath, filePath)
  } catch (error) {
    if (isEnoent(error)) {
      await mkdir(dirname(filePath), { recursive: true })
      await copyFile(backupPath, filePath)
    } else {
      throw error
    }
  }

  try {
    await chmod(filePath, backupStats.mode)
  } catch {
    // Best-effort mode restoration
  }
  return true
}

/**
 * Records a pre-edit `v1` backup for `filePath` into the most recent snapshot
 * BEFORE a tool modifies or creates the file on disk.
 */
export async function fileHistoryTrackEdit(
  updateFileHistoryState: FileHistoryUpdater,
  filePath: string,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  const trackingPath = maybeShortenFilePath(filePath)

  // Phase 1: Capture current state with no-op updater
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  const mostRecent = captured.snapshots.at(-1)
  if (!mostRecent) {
    logError(new Error('FileHistory: Missing most recent snapshot'))
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }

  // Already tracked in most recent snapshot: never overwrite deterministic v1
  if (mostRecent.trackedFileBackups[trackingPath]) {
    return
  }

  // Phase 2: Async pre-edit v1 backup
  let backup: FileHistoryBackup
  try {
    backup = await createBackup(filePath, 1)
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }
  const isAddingFile = backup.backupFileName === null

  // Phase 3: Commit with race re-check
  updateFileHistoryState(state => {
    const currentMostRecent = state.snapshots.at(-1)
    if (
      !currentMostRecent ||
      currentMostRecent.trackedFileBackups[trackingPath]
    ) {
      return state
    }

    const updatedTrackedFiles = state.trackedFiles.has(trackingPath)
      ? state.trackedFiles
      : new Set(state.trackedFiles).add(trackingPath)

    const updatedMostRecent: FileHistorySnapshot = {
      ...currentMostRecent,
      trackedFileBackups: {
        ...currentMostRecent.trackedFileBackups,
        [trackingPath]: backup,
      },
    }

    const nextSnapshots = state.snapshots.slice()
    nextSnapshots[nextSnapshots.length - 1] = updatedMostRecent

    void recordFileHistorySnapshot(messageId, updatedMostRecent, true).catch(
      err => {
        logError(new Error(`FileHistory: Failed to record snapshot: ${err}`))
      },
    )

    logEvent('tengu_file_history_track_edit_success', {
      isNewFile: isAddingFile,
      version: backup.version,
    })
    logForDebugging(`FileHistory: Tracked file modification for ${filePath}`)

    return {
      ...state,
      snapshots: nextSnapshots,
      trackedFiles: updatedTrackedFiles,
    }
  })
}

/**
 * Captures a per-turn file-history snapshot anchored at `messageId`, reusing
 * unchanged backups and backing up modified/deleted tracked files.
 */
export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: FileHistoryUpdater,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  // Phase 1: Capture current state
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  // Phase 2: Parallel async backup IO
  const trackedFileBackups: Record<string, FileHistoryBackup> = {}
  const mostRecentSnapshot = captured.snapshots.at(-1)

  if (mostRecentSnapshot) {
    await Promise.all(
      Array.from(captured.trackedFiles, async trackingPath => {
        try {
          const filePath = maybeExpandFilePath(trackingPath)
          const latestBackup =
            mostRecentSnapshot.trackedFileBackups[trackingPath]
          const nextVersion = latestBackup ? latestBackup.version + 1 : 1

          let fileStats: Stats | undefined
          try {
            fileStats = await stat(filePath)
          } catch (error) {
            if (!isEnoent(error)) throw error
          }

          if (!fileStats) {
            trackedFileBackups[trackingPath] = {
              backupFileName: null,
              version: nextVersion,
              backupTime: new Date(),
            }
            logEvent('tengu_file_history_backup_deleted_file', {
              version: nextVersion,
            })
            return
          }

          if (
            latestBackup &&
            latestBackup.backupFileName !== null &&
            !(await checkOriginFileChanged(
              filePath,
              latestBackup.backupFileName,
              fileStats,
            ))
          ) {
            trackedFileBackups[trackingPath] = latestBackup
            return
          }

          trackedFileBackups[trackingPath] = await createBackup(
            filePath,
            nextVersion,
          )
        } catch (error) {
          logError(error)
        }
      }),
    )
  }

  // Phase 3: Commit (inheriting any racing trackEdit additions)
  const now = new Date()
  updateFileHistoryState(state => {
    const mergedBackups: Record<string, FileHistoryBackup> = {
      ...trackedFileBackups,
    }
    const lastSnapshot = state.snapshots.at(-1)
    if (lastSnapshot) {
      for (const trackingPath of state.trackedFiles) {
        if (
          !(trackingPath in mergedBackups) &&
          lastSnapshot.trackedFileBackups[trackingPath]
        ) {
          mergedBackups[trackingPath] =
            lastSnapshot.trackedFileBackups[trackingPath]!
        }
      }
    }

    const newSnapshot: FileHistorySnapshot = {
      messageId,
      trackedFileBackups: mergedBackups,
      timestamp: now,
    }

    const allSnapshots = [...state.snapshots, newSnapshot]
    const cappedSnapshots =
      allSnapshots.length > MAX_SNAPSHOTS
        ? allSnapshots.slice(-MAX_SNAPSHOTS)
        : allSnapshots

    void recordFileHistorySnapshot(messageId, newSnapshot, false).catch(err => {
      logError(new Error(`FileHistory: Failed to record snapshot: ${err}`))
    })

    return {
      ...state,
      snapshots: cappedSnapshots,
      snapshotSequence: (state.snapshotSequence ?? 0) + 1,
    }
  })
}

/**
 * Returns `true` if a restorable snapshot exists for `messageId`.
 */
export function fileHistoryCanRestore(
  state: FileHistoryState,
  messageId: UUID,
): boolean {
  if (!fileHistoryEnabled()) {
    return false
  }
  return state.snapshots.some(s => s.messageId === messageId)
}

function findLastSnapshot(
  snapshots: readonly FileHistorySnapshot[],
  messageId: UUID,
): FileHistorySnapshot | undefined {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i]!.messageId === messageId) {
      return snapshots[i]
    }
  }
  return undefined
}

/**
 * Rewinds all tracked files on disk back to the state captured at `messageId`.
 * Does NOT mutate `FileHistoryState`.
 */
export async function fileHistoryRewind(
  updateFileHistoryState: FileHistoryUpdater,
  messageId: UUID,
): Promise<{ filesChanged: string[] }> {
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })

  const targetSnapshot = captured
    ? findLastSnapshot(captured.snapshots, messageId)
    : undefined

  if (!captured || !targetSnapshot) {
    logError(new Error(`FileHistory: Snapshot not found for ${messageId}`))
    logEvent('tengu_file_history_rewind_failed', { snapshotFound: false })
    throw new Error('The selected snapshot was not found')
  }

  const filesChanged: string[] = []

  for (const trackingPath of captured.trackedFiles) {
    const filePath = maybeExpandFilePath(trackingPath)
    const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
    const backupFileName = targetBackup
      ? targetBackup.backupFileName
      : getBackupFileNameFirstVersion(trackingPath, captured)

    if (backupFileName === undefined) {
      logError(
        new Error(
          `FileHistory: Missing v1 backup for ${trackingPath} during rewind`,
        ),
      )
      logEvent('tengu_file_history_rewind_restore_file_failed', {
        dryRun: false,
      })
      continue
    }

    if (backupFileName === null) {
      try {
        await unlink(filePath)
        filesChanged.push(trackingPath)
      } catch (error) {
        if (!isEnoent(error)) {
          throw error
        }
      }
      continue
    }

    if (await checkOriginFileChanged(filePath, backupFileName)) {
      const restored = await restoreBackup(filePath, backupFileName)
      if (restored) {
        filesChanged.push(trackingPath)
      }
    }
  }

  logEvent('tengu_file_history_rewind_success', {
    trackedFilesCount: captured.trackedFiles.size,
    filesChangedCount: filesChanged.length,
  })

  return { filesChanged }
}

/**
 * Computes dry-run diff statistics (`filesChanged`, `insertions`, `deletions`)
 * for rewinding disk files to `messageId`.
 */
export async function fileHistoryGetDiffStats(
  state: FileHistoryState,
  messageId: UUID,
): Promise<DiffStats> {
  if (!fileHistoryEnabled()) {
    return undefined
  }
  const targetSnapshot = findLastSnapshot(state.snapshots, messageId)
  if (!targetSnapshot) {
    return undefined
  }

  let insertions = 0
  let deletions = 0
  const filesChanged: string[] = []

  await Promise.all(
    Array.from(state.trackedFiles, async trackingPath => {
      const filePath = maybeExpandFilePath(trackingPath)
      const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
      const backupFileName = targetBackup
        ? targetBackup.backupFileName
        : getBackupFileNameFirstVersion(trackingPath, state)

      if (backupFileName === undefined) {
        return
      }

      const [originalContent, backupContent] = await Promise.all([
        readFileAsyncOrNull(filePath),
        backupFileName === null
          ? Promise.resolve(null)
          : readFileAsyncOrNull(resolveBackupPath(backupFileName)),
      ])

      const changes = diffLines(originalContent ?? '', backupContent ?? '')
      let fileInsertions = 0
      let fileDeletions = 0
      for (const part of changes) {
        const lineCount = part.count ?? 0
        if (part.added) {
          fileInsertions += lineCount
        } else if (part.removed) {
          fileDeletions += lineCount
        }
      }

      const zeroByteCreatedFile =
        backupFileName === null && (await pathExists(filePath))

      if (fileInsertions > 0 || fileDeletions > 0 || zeroByteCreatedFile) {
        insertions += fileInsertions
        deletions += fileDeletions
        filesChanged.push(trackingPath)
      }
    }),
  )

  return {
    filesChanged: filesChanged.sort(),
    insertions,
    deletions,
  }
}

/**
 * Fast boolean check whether rewinding to `messageId` would alter any tracked
 * file on disk (avoids running `diffLines`).
 */
export async function fileHistoryHasAnyChanges(
  state: FileHistoryState,
  messageId: UUID,
): Promise<boolean> {
  if (!fileHistoryEnabled()) {
    return false
  }
  const targetSnapshot = findLastSnapshot(state.snapshots, messageId)
  if (!targetSnapshot) {
    return false
  }

  for (const trackingPath of state.trackedFiles) {
    const filePath = maybeExpandFilePath(trackingPath)
    const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
    const backupFileName = targetBackup
      ? targetBackup.backupFileName
      : getBackupFileNameFirstVersion(trackingPath, state)

    if (backupFileName === undefined) {
      continue
    }
    if (backupFileName === null) {
      if (await pathExists(filePath)) {
        return true
      }
      continue
    }
    if (await checkOriginFileChanged(filePath, backupFileName)) {
      return true
    }
  }
  return false
}

/**
 * Restores `FileHistoryState` from persisted session snapshots, re-keying
 * legacy absolute paths through `maybeShortenFilePath`.
 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: readonly FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  const trackedFiles = new Set<string>()
  const normalizedSnapshots: FileHistorySnapshot[] = fileHistorySnapshots.map(
    snapshot => {
      const normalizedBackups: Record<string, FileHistoryBackup> = {}
      for (const [rawKey, backup] of Object.entries(
        snapshot.trackedFileBackups,
      )) {
        const key = maybeShortenFilePath(rawKey)
        trackedFiles.add(key)
        normalizedBackups[key] = {
          ...backup,
          backupTime:
            backup.backupTime instanceof Date
              ? backup.backupTime
              : new Date(backup.backupTime),
        }
      }
      return {
        messageId: snapshot.messageId,
        trackedFileBackups: normalizedBackups,
        timestamp:
          snapshot.timestamp instanceof Date
            ? snapshot.timestamp
            : new Date(snapshot.timestamp),
      }
    },
  )

  onUpdateState({
    snapshots: normalizedSnapshots.slice(-MAX_SNAPSHOTS),
    trackedFiles,
    snapshotSequence: normalizedSnapshots.length,
  })
}

/**
 * Migrates backup files from a resumed session ID into the active session's
 * `file-history/<newSessionId>/` directory via hard links (falling back to
 * `copyFile` across devices) and re-records migrated snapshots.
 */
export async function copyFileHistoryForResume(log: LogOption): Promise<void> {
  if (!fileHistoryEnabled() || !log.fileHistorySnapshots?.length) {
    return
  }

  const previousSessionId =
    log.messages.at(-1)?.sessionId ?? log.sessionId
  const currentSessionId = getSessionId()
  if (!previousSessionId || previousSessionId === currentSessionId) {
    return
  }

  const destDir = getFileHistorySessionDir(currentSessionId)
  await mkdir(destDir, { recursive: true, mode: 0o700 })

  for (const snapshot of log.fileHistorySnapshots) {
    let allCopied = true
    const backupNames = new Set<string>()
    for (const backup of Object.values(snapshot.trackedFileBackups)) {
      if (backup.backupFileName) {
        backupNames.add(backup.backupFileName)
      }
    }

    await Promise.all(
      Array.from(backupNames, async backupFileName => {
        const src = resolveBackupPath(backupFileName, previousSessionId)
        const dst = resolveBackupPath(backupFileName, currentSessionId)
        try {
          await link(src, dst)
        } catch (error) {
          const code = getErrnoCode(error)
          if (code === 'EEXIST') {
            return
          }
          if (code === 'ENOENT') {
            allCopied = false
            return
          }
          try {
            await copyFile(src, dst)
          } catch {
            allCopied = false
          }
        }
      }),
    )

    if (allCopied) {
      await recordFileHistorySnapshot(snapshot.messageId, snapshot, false)
    }
  }
}

/**
 * Removes expired per-session backup directories under `~/.copilot/file-history/`
 * older than `cleanupPeriodDays` (default 30 days).
 */
export async function cleanupOldFileHistoryBackups(
  overrideDays?: number,
): Promise<{ removedDirs: number }> {
  const days =
    overrideDays ??
    getInitialSettings().cleanupPeriodDays ??
    DEFAULT_CLEANUP_PERIOD_DAYS
  const cutoffMs = Date.now() - days * 86_400_000
  const rootDir = getFileHistoryRootDir()
  let removedDirs = 0

  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return { removedDirs: 0 }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionDir = join(rootDir, entry.name)
    try {
      const st = await stat(sessionDir)
      if (st.mtimeMs < cutoffMs) {
        await rm(sessionDir, { recursive: true, force: true })
        removedDirs++
      }
    } catch {
      // Ignore individual cleanup errors
    }
  }

  try {
    await rmdir(rootDir)
  } catch {
    // Non-empty or absent
  }

  return { removedDirs }
}
