/**
 * SDK session listing (`listSessionsImpl`): 64KB head/tail parsing, worktree
 * discovery, 32-entry batched progressive reads, and post-filter deduplication.
 */

import { readdir } from 'fs/promises'
import { join } from 'path'
import { listExistingWorktreePaths } from './get_worktree_paths_portable.js'
import { MAX_SANITIZED_LENGTH, sanitizePath } from './path.js'
import { listCandidates, type SessionCandidate } from './session_storage.js'
import {
  canonicalizePath,
  extractFirstPromptFromHead,
  extractJsonStringField,
  extractLastJsonStringField,
  findProjectDir,
  getProjectsDirPortable,
  type LiteSessionRead,
  readSessionLite,
} from './session_storage_portable.js'

const READ_BATCH_SIZE = 32

export interface SdkSessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

export interface ListSessionsOptions {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}

/**
 * Extracts `SdkSessionInfo` from a 64KB head/tail `LiteSessionRead`.
 * Returns `null` for sidechain files or metadata-only files lacking any
 * title/prompt/summary.
 */
export function parseSessionInfoFromLite(
  sessionId: string,
  lite: LiteSessionRead,
  projectPath?: string,
): SdkSessionInfo | null {
  const firstLineEnd = lite.head.indexOf('\n')
  const firstLine =
    firstLineEnd === -1 ? lite.head : lite.head.slice(0, firstLineEnd)
  if (
    firstLine.includes('"isSidechain":true') ||
    firstLine.includes('"isSidechain": true')
  ) {
    return null
  }

  const customTitle =
    extractLastJsonStringField(lite.tail, 'customTitle') ||
    extractJsonStringField(lite.head, 'customTitle') ||
    extractLastJsonStringField(lite.tail, 'aiTitle') ||
    extractJsonStringField(lite.head, 'aiTitle') ||
    undefined

  const firstPrompt = extractFirstPromptFromHead(lite.head) || undefined
  const lastPrompt = extractLastJsonStringField(lite.tail, 'lastPrompt')
  const tailSummary = extractLastJsonStringField(lite.tail, 'summary')

  const summary = customTitle || lastPrompt || tailSummary || firstPrompt
  if (!summary) {
    return null
  }

  // Scope tag extraction to col-0 `{"type":"tag"` lines to avoid tool_use collisions
  let tag: string | undefined
  const tailLines = lite.tail.split('\n')
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i]!
    if (line.startsWith('{"type":"tag"')) {
      tag = extractLastJsonStringField(line, 'tag') || undefined
      break
    }
  }

  const gitBranch =
    extractLastJsonStringField(lite.tail, 'gitBranch') ||
    extractJsonStringField(lite.head, 'gitBranch') ||
    undefined

  const cwd = extractJsonStringField(lite.head, 'cwd') || projectPath || undefined
  const headTimestamp = extractJsonStringField(lite.head, 'timestamp')
  const parsedCreatedAt = headTimestamp ? Date.parse(headTimestamp) : Number.NaN
  const createdAt = Number.isFinite(parsedCreatedAt)
    ? parsedCreatedAt
    : undefined

  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    ...(customTitle ? { customTitle } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tag ? { tag } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

async function gatherProjectDirs(
  options: ListSessionsOptions,
): Promise<Array<{ dir: string; projectPath?: string }>> {
  const projectsRoot = getProjectsDirPortable()

  if (!options.dir) {
    try {
      const entries = await readdir(projectsRoot, { withFileTypes: true })
      return entries
        .filter(e => e.isDirectory())
        .map(e => ({ dir: join(projectsRoot, e.name) }))
    } catch {
      return []
    }
  }

  const canonical = await canonicalizePath(options.dir)
  const dirs = new Map<string, string | undefined>()

  const direct = await findProjectDir(canonical)
  if (direct) {
    dirs.set(direct, canonical)
  }

  if (options.includeWorktrees !== false) {
    const worktrees: string[] = listExistingWorktreePaths(canonical)
    for (const wt of worktrees) {
      const wtDir = await findProjectDir(wt)
      if (wtDir && !dirs.has(wtDir)) {
        dirs.set(wtDir, wt)
      }
    }

    const longPrefixes = worktrees
      .map((wt: string) => ({ wt, sanitized: sanitizePath(wt) }))
      .filter(item => item.sanitized.length >= MAX_SANITIZED_LENGTH)
    if (longPrefixes.length > 0) {
      try {
        const entries = await readdir(projectsRoot, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const full = join(projectsRoot, entry.name)
          if (dirs.has(full)) continue
          const match = longPrefixes.find(p =>
            entry.name.startsWith(`${p.sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`),
          )
          if (match) {
            dirs.set(full, match.wt)
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  return Array.from(dirs.entries()).map(([dir, projectPath]) => ({
    dir,
    projectPath,
  }))
}

/**
 * Lists sessions via 64KB lite scanning with sorting (`lastModified desc,
 * sessionId desc`), pagination (`offset`/`limit`), and post-filter dedup.
 */
export async function listSessionsImpl(
  options: ListSessionsOptions = {},
): Promise<SdkSessionInfo[]> {
  const offset = Math.max(0, options.offset ?? 0)
  const limit =
    options.limit !== undefined && options.limit > 0
      ? options.limit
      : undefined

  const projectDirs = await gatherProjectDirs(options)
  if (projectDirs.length === 0) {
    return []
  }

  const candidateBags: Array<{
    candidate: SessionCandidate
    projectPath?: string
  }> = []

  await Promise.all(
    projectDirs.map(async ({ dir, projectPath }) => {
      const cands = await listCandidates(dir, true)
      for (const candidate of cands) {
        candidateBags.push({ candidate, projectPath })
      }
    }),
  )

  // Sort candidates by mtime desc, sessionId desc
  candidateBags.sort((a, b) => {
    const mtimeDiff = b.candidate.mtime - a.candidate.mtime
    if (mtimeDiff !== 0) return mtimeDiff
    return b.candidate.sessionId.localeCompare(a.candidate.sessionId)
  })

  const seenValidIds = new Set<string>()
  const collected: SdkSessionInfo[] = []
  let skipped = 0

  for (let i = 0; i < candidateBags.length; i += READ_BATCH_SIZE) {
    const batch = candidateBags.slice(i, i + READ_BATCH_SIZE)
    const parsedBatch = await Promise.all(
      batch.map(async ({ candidate, projectPath }) => {
        const lite = await readSessionLite(candidate.fullPath)
        if (!lite) return null
        return parseSessionInfoFromLite(candidate.sessionId, lite, projectPath)
      }),
    )

    for (const info of parsedBatch) {
      if (!info) continue
      if (seenValidIds.has(info.sessionId)) continue
      seenValidIds.add(info.sessionId)

      if (skipped < offset) {
        skipped++
        continue
      }
      collected.push(info)
      if (limit !== undefined && collected.length >= limit) {
        return collected
      }
    }
  }

  return collected
}
