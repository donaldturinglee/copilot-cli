import { readdirSync, type Dirent } from 'fs'
import { join, relative } from 'path'
import { FileIndex } from '../../../native/file_index/index.js'
import type { SuggestionItem } from './command_suggestions.js'

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
])

/**
 * Walk a workspace directory up to `maxFiles` entries for fast `@file`
 * autocomplete indexing.
 */
export function collectWorkspaceFiles(
  rootDir: string,
  maxFiles = 5000,
): string[] {
  const results: string[] = []
  const stack: string[] = [rootDir]

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break
      if (IGNORED_DIRS.has(entry.name)) continue
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else {
        const rel = relative(rootDir, fullPath).replace(/\\/g, '/')
        results.push(rel)
      }
    }
  }

  return results
}

export type MentionResource = {
  id: string
  label: string
  description?: string
  kind: 'mcp' | 'agent' | 'member'
}

/**
 * Sub-millisecond `@file` / MCP / Agent completion provider backed by the
 * pure-TS `native/file_index` fuzzy engine.
 */
export class FileSuggestionEngine {
  private readonly index = new FileIndex()
  private indexedRoot: string | null = null

  loadFiles(paths: string[]): void {
    this.index.loadFromFileList(paths)
  }

  async loadFilesAsync(paths: string[]): Promise<void> {
    const { done } = this.index.loadFromFileListAsync(paths)
    await done
  }

  ensureIndexed(rootDir: string, maxFiles = 5000): void {
    if (this.indexedRoot === rootDir && this.index.size() > 0) return
    this.indexedRoot = rootDir
    const files = collectWorkspaceFiles(rootDir, maxFiles)
    this.index.loadFromFileList(files)
  }

  size(): number {
    return this.index.size()
  }

  search(
    query: string,
    options?: {
      limit?: number
      extraResources?: readonly MentionResource[]
    },
  ): SuggestionItem[] {
    const limit = options?.limit ?? 12
    const fileHits = this.index.search(query, limit)
    const items: SuggestionItem[] = fileHits.map((hit, idx) => ({
      id: `file:${hit.path}`,
      displayText: `@${hit.path}`,
      insertText: `@${hit.path} `,
      description: 'file',
      kind: 'file',
      score: Math.max(1, 100 - idx * 2 - hit.score * 10),
    }))

    if (options?.extraResources) {
      const q = query.toLowerCase()
      for (const res of options.extraResources) {
        if (q && !res.label.toLowerCase().includes(q)) continue
        items.push({
          id: `${res.kind}:${res.id}`,
          displayText: `@${res.label}`,
          insertText: `@${res.label} `,
          description: res.description ?? res.kind,
          kind: res.kind,
          score: res.label.toLowerCase().startsWith(q) ? 95 : 70,
        })
      }
    }

    items.sort((a, b) => b.score - a.score)
    return items.slice(0, limit)
  }
}

const sharedFileSuggestionEngine = new FileSuggestionEngine()

export function getSharedFileSuggestionEngine(): FileSuggestionEngine {
  return sharedFileSuggestionEngine
}
