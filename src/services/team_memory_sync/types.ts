/**
 * API contract and sync state types for optional team memory synchronization.
 */

import { z } from 'zod/v4'
import type { SecretMatch } from './secret_scanner.js'

export interface TeamMemoryData {
  organizationId?: string
  repo: string
  version?: number
  lastModified?: string
  checksum: string
  content: {
    entries: Record<string, string>
    entryChecksums?: Record<string, string>
  }
}

export interface TeamMemoryHashesResponse {
  checksum: string
  entryChecksums: Record<string, string>
}

export const TeamMemoryTooManyEntriesSchema = z.object({
  error: z.object({
    details: z.object({
      error_code: z.literal('team_memory_too_many_entries'),
      max_entries: z.number().int().positive(),
      received_entries: z.number().int().nonnegative(),
    }),
  }),
})

export interface SyncState {
  lastKnownChecksum: string | null
  serverChecksums: Map<string, string>
  serverMaxEntries: number | null
}

export interface SkippedSecretFile {
  path: string
  ruleId: string
  label: string
}

export interface TeamMemoryPullResult {
  success: boolean
  notModified?: boolean
  filesWritten: number
  error?: string
  statusCode?: number
  reason?: 'no_oauth' | 'no_repo' | 'http_error' | 'network_error'
}

export interface TeamMemoryPushResult {
  success: boolean
  filesPushed: number
  skippedSecrets: SkippedSecretFile[]
  error?: string
  statusCode?: number
  serverMaxEntries?: number
  reason?: 'no_oauth' | 'no_repo' | 'http_error' | 'conflict' | 'network_error'
}

export interface TeamMemorySyncResult {
  pull: TeamMemoryPullResult
  push: TeamMemoryPushResult
}

export type SecretScanOutcome = {
  matches: SecretMatch[]
}
