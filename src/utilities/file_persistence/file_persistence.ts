/**
 * Turn-end output file persistence for BYOC (`COPILOT_CLI_ENVIRONMENT_KIND=byoc`)
 * sessions: scans `{cwd}/{sessionId}/outputs/` for regular files modified since
 * `turnStartTime`, validates path containment & count cap, and uploads them via
 * the Files API.
 */

import { join, relative } from 'path'
import { getSessionId, getSessionIngressToken } from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import { uploadFile } from '../../services/api/files_api.js'
import { getCwd } from '../cwd.js'
import { isFeatureEnabled } from '../feature_flags.js'
import { findModifiedFiles, getEnvironmentKind } from './outputs_scanner.js'
import {
  DEFAULT_UPLOAD_CONCURRENCY,
  FILE_COUNT_LIMIT,
  OUTPUTS_SUBDIR,
  type FailedPersistence,
  type FilesPersistedEventData,
  type PersistedFile,
  type TurnStartTime,
} from './types.js'

export * from './types.js'
export { findModifiedFiles, getEnvironmentKind } from './outputs_scanner.js'

/**
 * Returns `true` when BYOC file persistence is configured and enabled.
 */
export function isFilePersistenceEnabled(): boolean {
  return (
    isFeatureEnabled('FILE_PERSISTENCE') &&
    getEnvironmentKind() === 'byoc' &&
    Boolean(getSessionIngressToken()) &&
    Boolean(process.env.COPILOT_CLI_REMOTE_SESSION_ID)
  )
}

export type FileUploaderFn = (
  filePath: string,
  filename: string,
) => Promise<{ fileId: string }>

async function defaultUpload(
  filePath: string,
  filename: string,
): Promise<{ fileId: string }> {
  const uploaded = await uploadFile(filePath, { filename })
  return { fileId: uploaded.id }
}

/**
 * Scans `outputsDir` for turn-modified files and uploads them with bounded
 * concurrency, returning `{ files, failed }`.
 */
export async function executeFilePersistence(
  turnStartTime: TurnStartTime,
  options?: {
    outputsDir?: string
    concurrency?: number
    fileCountLimit?: number
    uploader?: FileUploaderFn
  },
): Promise<FilesPersistedEventData> {
  const outputsDir =
    options?.outputsDir ?? join(getCwd(), getSessionId(), OUTPUTS_SUBDIR)
  const limit = options?.fileCountLimit ?? FILE_COUNT_LIMIT
  const concurrency = Math.max(
    1,
    options?.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY,
  )
  const uploader = options?.uploader ?? defaultUpload

  const modifiedFiles = await findModifiedFiles(turnStartTime, outputsDir)
  if (modifiedFiles.length === 0) {
    return { files: [], failed: [] }
  }

  if (modifiedFiles.length > limit) {
    logEvent('tengu_file_persistence_limit_exceeded', {
      fileCount: modifiedFiles.length,
      limit,
    })
    return {
      files: [],
      failed: [
        {
          filename: outputsDir,
          error: `Modified file count (${modifiedFiles.length}) exceeds limit (${limit})`,
        },
      ],
    }
  }

  // Enforce strict directory containment on every candidate path
  const safeEntries: Array<{ filePath: string; relPath: string }> = []
  for (const filePath of modifiedFiles) {
    const relPath = relative(outputsDir, filePath).replace(/\\/g, '/')
    if (!relPath || relPath.startsWith('..')) {
      continue
    }
    safeEntries.push({ filePath, relPath })
  }

  const files: PersistedFile[] = []
  const failed: FailedPersistence[] = []

  for (let i = 0; i < safeEntries.length; i += concurrency) {
    const batch = safeEntries.slice(i, i + concurrency)
    const settled = await Promise.allSettled(
      batch.map(async entry => {
        const res = await uploader(entry.filePath, entry.relPath)
        return { filename: entry.relPath, file_id: res.fileId }
      }),
    )
    settled.forEach((outcome, idx) => {
      const entry = batch[idx]!
      if (outcome.status === 'fulfilled') {
        files.push(outcome.value)
      } else {
        failed.push({
          filename: entry.relPath,
          error:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
        })
      }
    })
  }

  return { files, failed }
}

/**
 * Top-level turn hook for file persistence; returns `null` outside BYOC mode.
 */
export async function runFilePersistence(
  turnStartTime: TurnStartTime,
  options?: Parameters<typeof executeFilePersistence>[1],
): Promise<FilesPersistedEventData | null> {
  if (getEnvironmentKind() !== 'byoc') {
    return null
  }
  if (!isFilePersistenceEnabled() && !options?.uploader) {
    return null
  }
  return executeFilePersistence(turnStartTime, options)
}
