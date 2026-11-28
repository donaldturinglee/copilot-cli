/**
 * Reconstructed pure type contracts and constants for BYOC/cloud turn file
 * persistence (`src/utilities/file_persistence/*`).
 */

export type TurnStartTime = number

export interface PersistedFile {
  filename: string
  file_id: string
}

export interface FailedPersistence {
  filename: string
  error: string
}

export interface FilesPersistedEventData {
  files: PersistedFile[]
  failed: FailedPersistence[]
}

export const OUTPUTS_SUBDIR = 'outputs'
export const UPLOADS_SUBDIR = 'uploads'
export const FILE_COUNT_LIMIT = 100
export const DEFAULT_UPLOAD_CONCURRENCY = 5
