/**
 * LRU-bounded `FileStateCache` tracking read file contents, timestamps, and
 * partial-view metadata for read-before-edit enforcement, staleness detection,
 * and unchanged-file deduplication.
 */

import { LRUCache } from 'lru-cache'
import { normalize, resolve } from 'path'
import { getPlatform } from './platform.js'

export const READ_FILE_STATE_CACHE_SIZE = 100
export const DEFAULT_FILE_STATE_MAX_BYTES = 25 * 1024 * 1024

export interface FileState {
  content: string
  timestamp: number
  offset?: number
  limit?: number
  isPartialView?: boolean
}

function normalizeFileStateKey(filePath: string): string {
  const normalized = normalize(resolve(filePath)).normalize('NFC')
  return getPlatform() === 'windows' ? normalized.toLowerCase() : normalized
}

/**
 * Path-normalized, byte-size and entry-count bounded LRU cache of file read
 * states. Preserves Map-compatible methods so existing callers work seamlessly.
 */
export class FileStateCache {
  private readonly lru: LRUCache<string, FileState>
  private readonly maxSizeBytes: number
  private readonly maxEntries: number

  constructor(
    maxSizeBytes: number = DEFAULT_FILE_STATE_MAX_BYTES,
    maxEntries: number = READ_FILE_STATE_CACHE_SIZE,
  ) {
    this.maxSizeBytes = maxSizeBytes
    this.maxEntries = maxEntries
    this.lru = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Math.max(1, value.content.length * 2),
    })
  }

  normalize(key: string): string {
    return normalizeFileStateKey(key)
  }

  get(key: string): FileState | undefined {
    return this.lru.get(this.normalize(key))
  }

  set(key: string, value: FileState): this {
    const normalized = this.normalize(key)
    const entrySize = Math.max(1, value.content.length * 2)
    if (entrySize > this.maxSizeBytes) {
      // Store metadata with truncated content placeholder so staleness/read tracking
      // still knows the file was read without blowing the memory budget.
      this.lru.set(normalized, {
        ...value,
        content: value.content.slice(0, Math.floor(this.maxSizeBytes / 4)),
      })
      return this
    }
    this.lru.set(normalized, value)
    return this
  }

  has(key: string): boolean {
    return this.lru.has(this.normalize(key))
  }

  delete(key: string): boolean {
    return this.lru.delete(this.normalize(key))
  }

  clear(): void {
    this.lru.clear()
  }

  get size(): number {
    return this.lru.size
  }

  keys(): IterableIterator<string> {
    return this.lru.keys()
  }

  values(): IterableIterator<FileState> {
    return this.lru.values()
  }

  entries(): IterableIterator<[string, FileState]> {
    return this.lru.entries()
  }

  [Symbol.iterator](): IterableIterator<[string, FileState]> {
    return this.lru.entries()
  }

  clone(): FileStateCache {
    const copy = new FileStateCache(this.maxSizeBytes, this.maxEntries)
    for (const [key, value] of this.lru.entries()) {
      copy.lru.set(key, { ...value })
    }
    return copy
  }
}

/**
 * Creates a `FileStateCache` bounded by byte size and entry count.
 */
export function createFileStateCacheWithSizeLimit(
  maxSizeBytes: number = DEFAULT_FILE_STATE_MAX_BYTES,
  maxEntries: number = READ_FILE_STATE_CACHE_SIZE,
): FileStateCache {
  return new FileStateCache(maxSizeBytes, maxEntries)
}

/**
 * Creates a default-sized `FileStateCache`.
 */
export function createFileStateCache(): FileStateCache {
  return createFileStateCacheWithSizeLimit()
}

/**
 * Returns a plain-object snapshot of cached file states.
 */
export function cacheToObject(cache: FileStateCache): Record<string, FileState> {
  const result: Record<string, FileState> = {}
  for (const [key, value] of cache.entries()) {
    result[key] = { ...value }
  }
  return result
}

/**
 * Returns an array of all cached normalized file paths.
 */
export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

/**
 * Deep-clones a `FileStateCache`.
 */
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  return cache.clone()
}

/**
 * Merges two `FileStateCache` instances, preferring the newer entry per path.
 */
export function mergeFileStateCaches(
  primary: FileStateCache,
  secondary: FileStateCache,
): FileStateCache {
  const merged = primary.clone()
  for (const [key, value] of secondary.entries()) {
    const existing = merged.get(key)
    if (!existing || value.timestamp >= existing.timestamp) {
      merged.set(key, { ...value })
    }
  }
  return merged
}
