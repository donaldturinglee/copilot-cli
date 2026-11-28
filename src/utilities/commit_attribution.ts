/**
 * Per-file edit attribution tracking, cumulative `attribution-snapshot`
 * serialization/restoration, and commit-level AI vs human contribution math.
 */

import { createHash, type UUID } from 'crypto'
import { existsSync, realpathSync } from 'fs'
import { stat } from 'fs/promises'
import { join, relative } from 'path'
import type { AttributionState } from '../types/forward.js'
import type {
  AttributionSnapshotMessage,
  FileAttributionState,
} from '../types/logs.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getCwd } from './cwd.js'
import { execFileNoThrowWithCwd } from './exec_file_no_throw.js'
import { isGeneratedFile } from './generated_files.js'
import { findGitRoot, getGitDir, gitExe } from './git.js'
import { recordAttributionSnapshot } from './session_storage.js'

const CHARS_PER_DIFF_LINE = 40
const DELETED_FILE_FALLBACK_CHARS = 100

/**
 * Computes a hex SHA-256 content hash for attribution tracking.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Resolves the repository root for attribution relative paths.
 */
export function getAttributionRepoRoot(): string {
  return findGitRoot(getCwd()) ?? getOriginalCwd()
}

/**
 * Normalizes `filePath` to a forward-slash repo-relative path after resolving
 * symlinks when possible.
 */
export function normalizeAttributionFilePath(filePath: string): string {
  const repoRoot = getAttributionRepoRoot()
  let resolvedPath = filePath
  let resolvedRoot = repoRoot
  try {
    resolvedPath = realpathSync(filePath)
  } catch {
    // File may not exist yet
  }
  try {
    resolvedRoot = realpathSync(repoRoot)
  } catch {
    // Keep original root
  }
  const rel = relative(resolvedRoot, resolvedPath).replace(/\\/g, '/')
  return rel && !rel.startsWith('..') ? rel : resolvedPath.replace(/\\/g, '/')
}

/**
 * Sanitizes internal or aliased model names to public marketing identifiers.
 */
export function sanitizeModelName(shortName: string): string {
  const lower = shortName.toLowerCase()
  if (lower.includes('opus-4-6') || lower.includes('opus 4.6')) {
    return 'claude-opus-4-6'
  }
  if (lower.includes('opus-4-5') || lower.includes('opus 4.5')) {
    return 'claude-opus-4-5'
  }
  if (lower.includes('opus-4-1') || lower.includes('opus 4.1')) {
    return 'claude-opus-4-1'
  }
  if (lower.includes('opus-4')) {
    return 'claude-opus-4'
  }
  if (lower.includes('sonnet-4-6') || lower.includes('sonnet 4.6')) {
    return 'claude-sonnet-4-6'
  }
  if (lower.includes('sonnet-4-5') || lower.includes('sonnet 4.5')) {
    return 'claude-sonnet-4-5'
  }
  if (lower.includes('sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (lower.includes('sonnet-3-7') || lower.includes('3-7-sonnet')) {
    return 'claude-sonnet-3-7'
  }
  if (lower.includes('haiku-4-5') || lower.includes('haiku 4.5')) {
    return 'claude-haiku-4-5'
  }
  if (lower.includes('haiku-3-5') || lower.includes('3-5-haiku')) {
    return 'claude-haiku-3-5'
  }
  return 'claude'
}

/**
 * Computes incremental changed character length via common prefix/suffix scan
 * so equal-length replacements (e.g. `"Esc" -> "esc"`) are accurately attributed.
 */
export function computeFileModificationState(
  oldContent: string | null,
  newContent: string | null,
  existing?: FileAttributionState,
): FileAttributionState {
  let deltaChars: number
  if (oldContent === null) {
    deltaChars = newContent?.length ?? 0
  } else if (newContent === null) {
    deltaChars = oldContent.length
  } else {
    let prefix = 0
    const minLen = Math.min(oldContent.length, newContent.length)
    while (
      prefix < minLen &&
      oldContent.charCodeAt(prefix) === newContent.charCodeAt(prefix)
    ) {
      prefix++
    }
    let suffix = 0
    while (
      suffix < minLen - prefix &&
      oldContent.charCodeAt(oldContent.length - 1 - suffix) ===
        newContent.charCodeAt(newContent.length - 1 - suffix)
    ) {
      suffix++
    }
    const oldChangedLen = oldContent.length - prefix - suffix
    const newChangedLen = newContent.length - prefix - suffix
    deltaChars = Math.max(oldChangedLen, newChangedLen)
  }

  return {
    contentHash: computeContentHash(newContent ?? ''),
    claudeContribution: (existing?.claudeContribution ?? 0) + deltaChars,
    mtime: Date.now(),
  }
}

function getFileStatesMap(
  state: AttributionState,
): Map<string, FileAttributionState> {
  return state.fileStates as Map<string, FileAttributionState>
}

export function trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
): AttributionState {
  const key = normalizeAttributionFilePath(filePath)
  const nextMap = new Map(getFileStatesMap(state))
  nextMap.set(
    key,
    computeFileModificationState(oldContent, newContent, nextMap.get(key)),
  )
  return { ...state, fileStates: nextMap }
}

export function trackFileCreation(
  state: AttributionState,
  filePath: string,
  content: string,
): AttributionState {
  const key = normalizeAttributionFilePath(filePath)
  const nextMap = new Map(getFileStatesMap(state))
  nextMap.set(key, computeFileModificationState(null, content, nextMap.get(key)))
  return { ...state, fileStates: nextMap }
}

export function trackFileDeletion(
  state: AttributionState,
  filePath: string,
  oldContent: string,
): AttributionState {
  const key = normalizeAttributionFilePath(filePath)
  const nextMap = new Map(getFileStatesMap(state))
  nextMap.set(
    key,
    computeFileModificationState(oldContent, null, nextMap.get(key)),
  )
  return { ...state, fileStates: nextMap }
}

export function trackBulkFileChanges(
  state: AttributionState,
  changes: ReadonlyArray<{
    filePath: string
    oldContent: string | null
    newContent: string | null
  }>,
): AttributionState {
  const nextMap = new Map(getFileStatesMap(state))
  for (const change of changes) {
    const key = normalizeAttributionFilePath(change.filePath)
    nextMap.set(
      key,
      computeFileModificationState(
        change.oldContent,
        change.newContent,
        nextMap.get(key),
      ),
    )
  }
  return { ...state, fileStates: nextMap }
}

/**
 * Returns `true` if git is currently in a transient merge/rebase/cherry-pick/bisect state.
 */
export function isGitTransientState(cwd: string = getCwd()): boolean {
  const gitDir = getGitDir(cwd)
  if (!gitDir) return false
  const markers = [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'BISECT_LOG',
  ]
  return markers.some(marker => existsSync(join(gitDir, marker)))
}

async function getGitDiffSize(file: string, cwd: string): Promise<number | null> {
  const res = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'diff', '--cached', '--numstat', '--', file],
    { cwd },
  )
  if (res.code !== 0) return null
  const firstLine = res.stdout.trim().split('\n')[0]
  if (!firstLine) return null
  const [addedRaw, deletedRaw] = firstLine.split('\t')
  const added = Number(addedRaw)
  const deleted = Number(deletedRaw)
  if (Number.isNaN(added) || Number.isNaN(deleted)) return null
  return (added + deleted) * CHARS_PER_DIFF_LINE
}

export interface CommitAttributionSummary {
  claudeChars: number
  humanChars: number
  claudePercent: number
  filesAnalyzed: number
}

/**
 * Estimates AI vs human character contribution across staged files.
 */
export async function calculateCommitAttribution(
  states: readonly AttributionState[],
  stagedFiles: readonly string[],
  cwd: string = getAttributionRepoRoot(),
): Promise<CommitAttributionSummary> {
  const merged = new Map<string, FileAttributionState>()
  for (const state of states) {
    for (const [file, info] of getFileStatesMap(state).entries()) {
      const existing = merged.get(file)
      if (!existing) {
        merged.set(file, { ...info })
      } else {
        merged.set(file, {
          contentHash: info.contentHash,
          claudeContribution:
            existing.claudeContribution + info.claudeContribution,
          mtime: Math.max(existing.mtime, info.mtime),
        })
      }
    }
  }

  let claudeChars = 0
  let humanChars = 0
  let filesAnalyzed = 0

  for (const file of stagedFiles) {
    if (isGeneratedFile(file)) continue
    filesAnalyzed++
    const key = file.replace(/\\/g, '/')
    const tracked = merged.get(key)
    const fullPath = join(cwd, file)

    let fileStats
    try {
      fileStats = await stat(fullPath)
    } catch {
      fileStats = null
    }

    if (!fileStats) {
      if (tracked && tracked.claudeContribution > 0) {
        claudeChars += tracked.claudeContribution
      } else {
        const diffChars = await getGitDiffSize(file, cwd)
        humanChars += diffChars ?? DELETED_FILE_FALLBACK_CHARS
      }
      continue
    }

    if (tracked && tracked.claudeContribution > 0) {
      claudeChars += tracked.claudeContribution
    } else {
      const diffChars = await getGitDiffSize(file, cwd)
      humanChars += diffChars ?? fileStats.size
    }
  }

  const total = claudeChars + humanChars
  const claudePercent = total > 0 ? Math.round((claudeChars / total) * 100) : 0
  return { claudeChars, humanChars, claudePercent, filesAnalyzed }
}

/**
 * Serializes cumulative attribution state into a persistable snapshot entry.
 */
export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: UUID,
  surface = 'cli',
): AttributionSnapshotMessage {
  const fileStates: Record<string, FileAttributionState> = {}
  for (const [key, value] of getFileStatesMap(state).entries()) {
    fileStates[key] = { ...value }
  }
  return {
    type: 'attribution-snapshot',
    messageId,
    surface,
    fileStates,
    promptCount: state.promptCount,
    promptCountAtLastCommit: state.promptCountAtLastCommit,
    permissionPromptCount: state.permissionPromptCount,
    permissionPromptCountAtLastCommit: state.permissionPromptCountAtLastCommit,
    escapeCount: state.escapeCount,
    escapeCountAtLastCommit: state.escapeCountAtLastCommit,
  }
}

/**
 * Restores `AttributionState` using ONLY the final cumulative snapshot
 * (`snapshots[snapshots.length - 1]`) to avoid quadratic double-counting.
 */
export function restoreAttributionStateFromSnapshots(
  snapshots: readonly AttributionSnapshotMessage[],
): AttributionState {
  const last = snapshots.at(-1)
  if (!last) {
    return {
      fileStates: new Map(),
      promptCount: 0,
      promptCountAtLastCommit: 0,
      permissionPromptCount: 0,
      permissionPromptCountAtLastCommit: 0,
      escapeCount: 0,
      escapeCountAtLastCommit: 0,
    }
  }

  const fileStates = new Map<string, FileAttributionState>()
  for (const [key, value] of Object.entries(last.fileStates)) {
    fileStates.set(key, { ...value })
  }

  return {
    fileStates,
    promptCount: last.promptCount ?? 0,
    promptCountAtLastCommit: last.promptCountAtLastCommit ?? 0,
    permissionPromptCount: last.permissionPromptCount ?? 0,
    permissionPromptCountAtLastCommit:
      last.permissionPromptCountAtLastCommit ?? 0,
    escapeCount: last.escapeCount ?? 0,
    escapeCountAtLastCommit: last.escapeCountAtLastCommit ?? 0,
  }
}

/**
 * Increments the prompt counter and persists a snapshot so N-shot counts
 * survive compaction.
 */
export function incrementPromptCount(
  state: AttributionState,
  messageId: UUID,
): AttributionState {
  const next: AttributionState = {
    ...state,
    promptCount: state.promptCount + 1,
  }
  void recordAttributionSnapshot(stateToSnapshotMessage(next, messageId))
  return next
}
