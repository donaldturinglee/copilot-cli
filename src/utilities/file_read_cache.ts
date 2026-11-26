import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fs_operations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

const MAX_FILE_READ_CACHE_SIZE = 1000

/**
 * Simple in-memory cache for file contents with automatic invalidation based on mtime.
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()

  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fsImpl = getFsImplementation()

    let stats
    try {
      stats = fsImpl.statSync(filePath)
    } catch (error) {
      this.cache.delete(filePath)
      throw error
    }

    const cachedData = this.cache.get(filePath)
    if (cachedData && cachedData.mtime === stats.mtimeMs) {
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    const encoding = detectFileEncoding(filePath)
    const content = fsImpl
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    this.cache.set(filePath, {
      content,
      encoding,
      mtime: stats.mtimeMs,
    })

    if (this.cache.size > MAX_FILE_READ_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    return { content, encoding }
  }

  clear(): void {
    this.cache.clear()
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  getStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    }
  }
}

export const fileReadCache = new FileReadCache()
