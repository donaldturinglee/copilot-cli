/**
 * Optional server-backed Team Memory Sync (`src/services/team_memory_sync/index.ts`):
 * - Delta-only synchronization using SHA-256 entry checksums and ETag (`If-None-Match` / `If-Match`)
 * - Client-side secret scanning (36 curated rules) skipping files containing credentials
 * - Path traversal & symlink validation via `validateTeamMemKey`
 * - Greedy 200KB PUT batching, 412 conflict retry via `&view=hashes`, and 413 `serverMaxEntries`
 */

import { createHash } from 'crypto'
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { OAUTH_BETA_HEADER, getOauthConfig } from '../../constants/oauth.js'
import {
  getTeamMemPath,
  isTeamMemoryEnabled,
  PathTraversalError,
  validateTeamMemKey,
} from '../../memdir/team_mem_paths.js'
import { getClaudeAiOauthTokens } from '../../utilities/auth.js'
import { clearMemoryFileCaches } from '../../utilities/claudemd.js'
import { logForDebugging } from '../../utilities/debug.js'
import { getErrnoCode } from '../../utilities/errors.js'
import { getRemoteUrl, normalizeGitRemoteUrl } from '../../utilities/git.js'
import { logEvent } from '../analytics/index.js'
import { scanForSecrets } from './secret_scanner.js'
import {
  type SkippedSecretFile,
  type SyncState,
  type TeamMemoryData,
  type TeamMemoryHashesResponse,
  type TeamMemoryPullResult,
  type TeamMemoryPushResult,
  type TeamMemorySyncResult,
  TeamMemoryTooManyEntriesSchema,
} from './types.js'

export const TEAM_MEMORY_SYNC_TIMEOUT_MS = 30_000
export const MAX_FILE_SIZE_BYTES = 250_000
export const MAX_PUT_BODY_BYTES = 200_000
export const MAX_RETRIES = 3
export const MAX_CONFLICT_RETRIES = 2
export const DEFAULT_RETRY_DELAY_MS = 500

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface TeamMemorySyncOptions {
  fetchFn?: FetchLike
  baseUrl?: string
  authToken?: string | null
  repoSlug?: string | null
  teamMemDir?: string
  retryDelayMs?: number
  signal?: AbortSignal
}

/**
 * Creates an empty mutable sync state tracking server ETag and entry hashes.
 */
export function createSyncState(): SyncState {
  return {
    lastKnownChecksum: null,
    serverChecksums: new Map<string, string>(),
    serverMaxEntries: null,
  }
}

/**
 * Computes the server-compatible `sha256:<hex>` content checksum.
 */
export function hashContent(content: string): string {
  const digest = createHash('sha256').update(content, 'utf8').digest('hex')
  return `sha256:${digest}`
}

/**
 * Greedy bin-packing splitting a delta map into JSON-serialized PUT batches
 * under `maxBytes` (default `200KB`). Single oversized entries are placed in
 * their own batch.
 */
export function batchDeltaByBytes(
  delta: Record<string, string>,
  maxBytes: number = MAX_PUT_BODY_BYTES,
): Record<string, string>[] {
  const entries = Object.entries(delta)
  if (entries.length === 0) {
    return []
  }

  const batches: Record<string, string>[] = []
  let current: Record<string, string> = {}
  let currentSize = 2 // `{}`

  for (const [key, value] of entries) {
    const entrySize = Buffer.byteLength(
      JSON.stringify({ [key]: value }),
      'utf8',
    )
    if (
      Object.keys(current).length > 0 &&
      currentSize + entrySize > maxBytes
    ) {
      batches.push(current)
      current = {}
      currentSize = 2
    }
    current[key] = value
    currentSize += entrySize
  }

  if (Object.keys(current).length > 0) {
    batches.push(current)
  }

  return batches
}

async function resolveAuthAndRepo(
  options?: TeamMemorySyncOptions,
): Promise<{
  token: string | null
  repo: string | null
  baseUrl: string
}> {
  const token =
    options?.authToken !== undefined
      ? options.authToken
      : (getClaudeAiOauthTokens()?.accessToken ?? null)

  let repo = options?.repoSlug !== undefined ? options.repoSlug : null
  if (repo === null && options?.repoSlug === undefined) {
    const remote = await getRemoteUrl()
    repo = remote ? normalizeGitRemoteUrl(remote) : null
  }

  const baseUrl = (
    options?.baseUrl ?? getOauthConfig().BASE_API_URL
  ).replace(/\/+$/, '')

  return { token, repo, baseUrl }
}

/**
 * Returns `true` if team memory sync has an active OAuth token, a resolvable
 * git repository slug, and team memory is enabled.
 */
export async function isTeamMemorySyncAvailable(
  options?: TeamMemorySyncOptions,
): Promise<boolean> {
  if (!isTeamMemoryEnabled() && !options?.teamMemDir) {
    return false
  }
  const { token, repo } = await resolveAuthAndRepo(options)
  return Boolean(token && repo)
}

function buildHeaders(
  token: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA_HEADER,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: TeamMemorySyncOptions,
): Promise<Response> {
  const fetchFn: FetchLike = options?.fetchFn ?? ((u, i) => fetch(u, i))
  const baseDelay = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      TEAM_MEMORY_SYNC_TIMEOUT_MS,
    )
    timeout.unref?.()

    const onOuterAbort = () => controller.abort()
    options?.signal?.addEventListener('abort', onOuterAbort, { once: true })

    try {
      const response = await fetchFn(url, {
        ...init,
        signal: controller.signal,
      })
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const delay = baseDelay * 2 ** attempt
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay))
        }
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (options?.signal?.aborted || attempt >= MAX_RETRIES) {
        throw error
      }
      const delay = baseDelay * 2 ** attempt
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    } finally {
      clearTimeout(timeout)
      options?.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function collectLocalTeamMemoryFiles(
  rootDir: string,
): Promise<Array<{ key: string; fullPath: string; content: string }>> {
  const results: Array<{ key: string; fullPath: string; content: string }> = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      try {
        const lst = await lstat(fullPath)
        if (lst.isSymbolicLink()) {
          continue
        }
        if (lst.isDirectory()) {
          await walk(fullPath)
          continue
        }
        if (!lst.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
          continue
        }
        if (lst.size > MAX_FILE_SIZE_BYTES) {
          logForDebugging(
            `Skipping team memory file > ${MAX_FILE_SIZE_BYTES} bytes: ${fullPath}`,
          )
          continue
        }
        const content = await readFile(fullPath, 'utf8')
        const relKey = relative(rootDir, fullPath).replace(/\\/g, '/')
        results.push({ key: relKey, fullPath, content })
      } catch {
        // Ignore unreadable transient entries
      }
    }
  }

  await walk(rootDir)
  return results
}

/**
 * Pulls team memory entries from the server using conditional `If-None-Match`.
 * Validates every key against path traversal & symlinks before writing.
 */
export async function pullTeamMemory(
  state: SyncState,
  options?: TeamMemorySyncOptions,
): Promise<TeamMemoryPullResult> {
  const { token, repo, baseUrl } = await resolveAuthAndRepo(options)
  if (!token) {
    return { success: false, filesWritten: 0, reason: 'no_oauth' }
  }
  if (!repo) {
    return { success: false, filesWritten: 0, reason: 'no_repo' }
  }

  const url = `${baseUrl}/api/claude_code/team_memory?repo=${encodeURIComponent(repo)}`
  const headers = buildHeaders(
    token,
    state.lastKnownChecksum ? { 'If-None-Match': state.lastKnownChecksum } : {},
  )

  let response: Response
  try {
    response = await fetchWithRetry(url, { method: 'GET', headers }, options)
  } catch (error) {
    return {
      success: false,
      filesWritten: 0,
      reason: 'network_error',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (response.status === 304) {
    return { success: true, notModified: true, filesWritten: 0, statusCode: 304 }
  }

  if (response.status === 404) {
    state.lastKnownChecksum = null
    state.serverChecksums.clear()
    return { success: true, filesWritten: 0, statusCode: 404 }
  }

  if (!response.ok) {
    return {
      success: false,
      filesWritten: 0,
      statusCode: response.status,
      reason: 'http_error',
      error: `HTTP ${response.status}`,
    }
  }

  const data = (await response.json()) as TeamMemoryData
  const entries = data.content?.entries ?? {}
  const serverEntryChecksums = data.content?.entryChecksums ?? {}

  state.lastKnownChecksum = data.checksum ?? null
  state.serverChecksums.clear()

  let filesWritten = 0
  for (const [key, content] of Object.entries(entries)) {
    if (typeof content !== 'string') continue
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE_BYTES) {
      continue
    }

    let safeTarget: string
    try {
      safeTarget = options?.teamMemDir
        ? await validateCustomTeamKey(options.teamMemDir, key)
        : await validateTeamMemKey(key)
    } catch (error) {
      if (error instanceof PathTraversalError) {
        logEvent('tengu_team_mem_path_traversal_blocked', { blocked: true })
        continue
      }
      throw error
    }

    const checksum = serverEntryChecksums[key] ?? hashContent(content)
    state.serverChecksums.set(key, checksum)

    // Skip disk write if identical content is already present locally
    let existing: string | null = null
    try {
      const existingStat = await stat(safeTarget)
      if (existingStat.isFile()) {
        existing = await readFile(safeTarget, 'utf8')
      }
    } catch {
      // Missing locally
    }

    if (existing !== content) {
      await mkdir(dirname(safeTarget), { recursive: true, mode: 0o700 })
      await writeFile(safeTarget, content, { encoding: 'utf8', mode: 0o600 })
      filesWritten++
    }
  }

  if (filesWritten > 0) {
    clearMemoryFileCaches()
  }

  return {
    success: true,
    filesWritten,
    statusCode: response.status,
  }
}

async function validateCustomTeamKey(
  customDir: string,
  key: string,
): Promise<string> {
  // Reuse strict key sanitization even when an isolated test directory is injected
  const { sanitizePathKey } = await import('../../memdir/team_mem_paths.js')
  const cleanKey = sanitizePathKey(key)
  return join(customDir, cleanKey)
}

async function refreshServerHashes(
  state: SyncState,
  baseUrl: string,
  repo: string,
  token: string,
  options?: TeamMemorySyncOptions,
): Promise<boolean> {
  const url = `${baseUrl}/api/claude_code/team_memory?repo=${encodeURIComponent(repo)}&view=hashes`
  const response = await fetchWithRetry(
    url,
    { method: 'GET', headers: buildHeaders(token) },
    options,
  )
  if (!response.ok) {
    return false
  }
  const data = (await response.json()) as TeamMemoryHashesResponse
  state.lastKnownChecksum = data.checksum ?? null
  state.serverChecksums.clear()
  for (const [key, hash] of Object.entries(data.entryChecksums ?? {})) {
    state.serverChecksums.set(key, hash)
  }
  return true
}

/**
 * Pushes changed local team memory files in <=200KB delta batches after scanning
 * every file for secrets. Retries 412 ETag conflicts up to `MAX_CONFLICT_RETRIES`.
 */
export async function pushTeamMemory(
  state: SyncState,
  options?: TeamMemorySyncOptions,
): Promise<TeamMemoryPushResult> {
  const { token, repo, baseUrl } = await resolveAuthAndRepo(options)
  if (!token) {
    return {
      success: false,
      filesPushed: 0,
      skippedSecrets: [],
      reason: 'no_oauth',
    }
  }
  if (!repo) {
    return {
      success: false,
      filesPushed: 0,
      skippedSecrets: [],
      reason: 'no_repo',
    }
  }

  const rootDir = options?.teamMemDir ?? getTeamMemPath()
  const localFiles = await collectLocalTeamMemoryFiles(rootDir)

  const skippedSecrets: SkippedSecretFile[] = []
  const safeFiles: Array<{ key: string; content: string; hash: string }> = []

  for (const file of localFiles) {
    const matches = scanForSecrets(file.content)
    if (matches.length > 0) {
      skippedSecrets.push({
        path: file.key,
        ruleId: matches[0]!.ruleId,
        label: matches[0]!.label,
      })
      continue
    }
    safeFiles.push({
      key: file.key,
      content: file.content,
      hash: hashContent(file.content),
    })
  }

  let filesPushed = 0
  const url = `${baseUrl}/api/claude_code/team_memory?repo=${encodeURIComponent(repo)}`

  for (let conflictAttempt = 0; conflictAttempt <= MAX_CONFLICT_RETRIES; conflictAttempt++) {
    const delta: Record<string, string> = {}
    for (const file of safeFiles) {
      if (state.serverChecksums.get(file.key) !== file.hash) {
        delta[file.key] = file.content
      }
    }

    const batches = batchDeltaByBytes(delta)
    if (batches.length === 0) {
      return {
        success: true,
        filesPushed,
        skippedSecrets,
      }
    }

    let encounteredConflict = false

    for (const batch of batches) {
      const headers = buildHeaders(
        token,
        state.lastKnownChecksum ? { 'If-Match': state.lastKnownChecksum } : {},
      )

      let response: Response
      try {
        response = await fetchWithRetry(
          url,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify({ entries: batch }),
          },
          options,
        )
      } catch (error) {
        return {
          success: false,
          filesPushed,
          skippedSecrets,
          reason: 'network_error',
          error: error instanceof Error ? error.message : String(error),
        }
      }

      if (response.status === 412) {
        encounteredConflict = true
        if (conflictAttempt < MAX_CONFLICT_RETRIES) {
          const refreshed = await refreshServerHashes(
            state,
            baseUrl,
            repo,
            token,
            options,
          )
          if (!refreshed) {
            return {
              success: false,
              filesPushed,
              skippedSecrets,
              statusCode: 412,
              reason: 'conflict',
              error: 'Conflict refreshing team memory hashes',
            }
          }
          break
        }
        return {
          success: false,
          filesPushed,
          skippedSecrets,
          statusCode: 412,
          reason: 'conflict',
          error: 'Exceeded maximum 412 conflict retries',
        }
      }

      if (response.status === 413) {
        let serverMaxEntries: number | undefined
        try {
          const parsed = TeamMemoryTooManyEntriesSchema.safeParse(
            await response.json(),
          )
          if (parsed.success) {
            serverMaxEntries = parsed.data.error.details.max_entries
            state.serverMaxEntries = serverMaxEntries
          }
        } catch {
          // Non-JSON 413 body
        }
        return {
          success: false,
          filesPushed,
          skippedSecrets,
          statusCode: 413,
          serverMaxEntries,
          reason: 'http_error',
          error: 'Team memory entry limit exceeded',
        }
      }

      if (!response.ok) {
        return {
          success: false,
          filesPushed,
          skippedSecrets,
          statusCode: response.status,
          reason: 'http_error',
          error: `HTTP ${response.status}`,
        }
      }

      try {
        const updated = (await response.json()) as Partial<TeamMemoryData>
        if (typeof updated.checksum === 'string') {
          state.lastKnownChecksum = updated.checksum
        }
      } catch {
        // Optional response body
      }

      for (const [key, content] of Object.entries(batch)) {
        state.serverChecksums.set(key, hashContent(content))
        filesPushed++
      }
    }

    if (!encounteredConflict) {
      return {
        success: true,
        filesPushed,
        skippedSecrets,
      }
    }
  }

  return {
    success: false,
    filesPushed,
    skippedSecrets,
    statusCode: 412,
    reason: 'conflict',
  }
}

/**
 * Performs a full pull-then-push team memory sync cycle.
 */
export async function syncTeamMemory(
  state: SyncState,
  options?: TeamMemorySyncOptions,
): Promise<TeamMemorySyncResult> {
  const pull = await pullTeamMemory(state, options)
  const push = await pushTeamMemory(state, options)
  return { pull, push }
}
