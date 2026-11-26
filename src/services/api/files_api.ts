/**
 * Anthropic Files API client: upload, download, list, and CLI `--file` spec parsing
 * with retry backoff, path-traversal protection, and 500MB safety cap.
 */

import axios from 'axios'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, normalize, resolve } from 'path'
import { getOauthConfig } from '../../constants/oauth.js'
import { getAuthHeaders, getUserAgent } from '../../utilities/http.js'
import { sleep } from '../../utilities/sleep.js'

export const FILES_API_BETA_HEADER = 'files-api-2025-04-14,oauth-2025-04-20'
export const ANTHROPIC_VERSION = '2023-06-01'
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 500 MB
const MAX_RETRIES = 3
const BASE_DELAY_MS = 500
const DOWNLOAD_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 120_000
const DEFAULT_CONCURRENCY = 5

export interface FileSpec {
  fileId: string
  relativePath: string
}

export interface RemoteFileMetadata {
  id: string
  filename: string
  size_bytes: number
  created_at: string
  mime_type?: string
}

function getFilesApiBaseUrl(): string {
  return (
    process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL
  ).replace(/\/+$/, '')
}

function buildFilesApiHeaders(): Record<string, string> {
  const auth = getAuthHeaders()
  if (auth.error) {
    throw new Error(`Files API authentication failed: ${auth.error}`)
  }
  return {
    ...auth.headers,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
    'User-Agent': getUserAgent(),
  }
}

async function withFileApiRetry<Result>(
  fn: () => Promise<Result>,
): Promise<Result> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const status = (error as { response?: { status?: number } })?.response
        ?.status
      const retryable = status === undefined || status === 429 || status >= 500
      if (!retryable || attempt === MAX_RETRIES) {
        throw error
      }
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1))
    }
  }
  throw lastError
}

/**
 * Parses CLI `--file` specs (`<file_id>:<relative_path>`).
 */
export function parseFileSpecs(specs: readonly string[]): FileSpec[] {
  const results: FileSpec[] = []
  for (const spec of specs) {
    const colonIdx = spec.indexOf(':')
    if (colonIdx <= 0 || colonIdx === spec.length - 1) {
      throw new Error(
        `Invalid --file spec "${spec}". Expected "<file_id>:<relative_path>".`,
      )
    }
    const fileId = spec.slice(0, colonIdx).trim()
    const relativePath = spec.slice(colonIdx + 1).trim()
    if (!fileId || !relativePath) {
      throw new Error(
        `Invalid --file spec "${spec}". Expected "<file_id>:<relative_path>".`,
      )
    }
    results.push({ fileId, relativePath })
  }
  return results
}

/**
 * Resolves a safe local destination path inside `targetDir`, rejecting `..`
 * path traversal and stripping redundant upload prefixes.
 */
export function buildDownloadPath(
  targetDir: string,
  relativePath: string,
  sessionId?: string,
): string {
  let cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (sessionId) {
    const sessionUploadsPrefix = `${sessionId}/uploads/`
    const idx = cleaned.indexOf(sessionUploadsPrefix)
    if (idx >= 0) {
      cleaned = cleaned.slice(idx + sessionUploadsPrefix.length)
    }
  }
  if (cleaned.startsWith('uploads/')) {
    cleaned = cleaned.slice('uploads/'.length)
  }

  const normalized = normalize(cleaned)
  if (
    isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${'/'}`) ||
    normalized.startsWith('..\\') ||
    normalized.includes('/../') ||
    normalized.includes('\\..\\')
  ) {
    throw new Error(
      `Refusing to download file outside workspace: "${relativePath}"`,
    )
  }

  const resolvedBase = resolve(targetDir)
  const resolvedDest = resolve(resolvedBase, normalized)
  if (
    resolvedDest !== resolvedBase &&
    !resolvedDest.startsWith(resolvedBase + '/') &&
    !resolvedDest.startsWith(resolvedBase + '\\')
  ) {
    throw new Error(
      `Refusing to download file outside workspace: "${relativePath}"`,
    )
  }
  return resolvedDest
}

/**
 * Downloads raw file bytes from `GET /v1/files/:id/content`.
 */
export async function downloadFile(
  fileId: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const url = `${getFilesApiBaseUrl()}/v1/files/${encodeURIComponent(fileId)}/content`
  return withFileApiRetry(async () => {
    const response = await axios.get<ArrayBuffer>(url, {
      headers: buildFilesApiHeaders(),
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_FILE_SIZE_BYTES,
      signal,
    })
    return Buffer.from(response.data)
  })
}

/**
 * Downloads a file by ID and saves it inside `targetDir` safely.
 */
export async function downloadAndSaveFile(
  fileId: string,
  targetDir: string,
  relativePath: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const destPath = buildDownloadPath(targetDir, relativePath, sessionId)
  const buffer = await downloadFile(fileId, signal)
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Downloaded file "${fileId}" exceeds max size (${MAX_FILE_SIZE_BYTES} bytes).`,
    )
  }
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, buffer)
  return destPath
}

/**
 * Downloads a batch of session files with bounded concurrency.
 */
export async function downloadSessionFiles(
  specs: readonly FileSpec[],
  targetDir: string,
  options?: {
    sessionId?: string
    concurrency?: number
    signal?: AbortSignal
  },
): Promise<string[]> {
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY
  const results: string[] = new Array<string>(specs.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < specs.length) {
      const idx = nextIndex++
      const spec = specs[idx]!
      results[idx] = await downloadAndSaveFile(
        spec.fileId,
        targetDir,
        spec.relativePath,
        options?.sessionId,
        options?.signal,
      )
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, specs.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

/**
 * Uploads a local file to `POST /v1/files` using multipart/form-data (`purpose=user_data`).
 */
export async function uploadFile(
  filePath: string,
  options?: { filename?: string; signal?: AbortSignal },
): Promise<RemoteFileMetadata> {
  const stats = await stat(filePath)
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File "${filePath}" exceeds max upload size (${MAX_FILE_SIZE_BYTES} bytes).`,
    )
  }
  const content = await readFile(filePath)
  const fileName = options?.filename ?? basename(filePath)
  const boundary = `----CopilotCliBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`

  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
      `user_data\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, '_')}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    'utf-8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
  const body = Buffer.concat([head, content, tail])

  const url = `${getFilesApiBaseUrl()}/v1/files`
  return withFileApiRetry(async () => {
    const response = await axios.post<RemoteFileMetadata>(url, body, {
      headers: {
        ...buildFilesApiHeaders(),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.byteLength),
      },
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: MAX_FILE_SIZE_BYTES + 1024 * 1024,
      signal: options?.signal,
    })
    return response.data
  })
}

/**
 * Uploads a batch of files with bounded concurrency.
 */
export async function uploadSessionFiles(
  filePaths: readonly string[],
  options?: { concurrency?: number; signal?: AbortSignal },
): Promise<RemoteFileMetadata[]> {
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY
  const results: RemoteFileMetadata[] = new Array<RemoteFileMetadata>(
    filePaths.length,
  )
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < filePaths.length) {
      const idx = nextIndex++
      results[idx] = await uploadFile(filePaths[idx]!, {
        signal: options?.signal,
      })
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, filePaths.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

/**
 * Paginates `GET /v1/files` returning files created after `afterCreatedAt`.
 */
export async function listFilesCreatedAfter(
  afterCreatedAt: string,
  signal?: AbortSignal,
): Promise<RemoteFileMetadata[]> {
  const url = `${getFilesApiBaseUrl()}/v1/files`
  const collected: RemoteFileMetadata[] = []
  let afterId: string | undefined

  while (true) {
    const response = await withFileApiRetry(() =>
      axios.get<{
        data?: RemoteFileMetadata[]
        has_more?: boolean
        last_id?: string
      }>(url, {
        headers: buildFilesApiHeaders(),
        params: {
          after_created_at: afterCreatedAt,
          ...(afterId ? { after_id: afterId } : {}),
        },
        timeout: DOWNLOAD_TIMEOUT_MS,
        signal,
      }),
    )

    const items = response.data?.data ?? []
    collected.push(...items)
    if (!response.data?.has_more || !response.data?.last_id) {
      break
    }
    afterId = response.data.last_id
  }

  return collected
}
