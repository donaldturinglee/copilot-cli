/**
 * Pure-TS time-sliced fuzzy file index with 26-bit bitmap prefiltering,
 * nucleo-style fuzzy scoring, Top-K ranking, and 1.05x test-path penalty.
 */

export type SearchResult = {
  path: string
  score: number
}

// Nucleo-inspired scoring constants
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_CONSECUTIVE = 4
const BONUS_FIRST_CHAR = 8
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1

// Upper bound on per-character match score (SCORE_MATCH + max(BOUNDARY, FIRST_CHAR))
const MAX_CHAR_SCORE = SCORE_MATCH + BONUS_BOUNDARY

// Time budget per async indexing chunk (ms) to keep frame pacing smooth
export const CHUNK_MS = 4
// Number of paths processed before checking performance.now()
const BATCH_SIZE = 2048

const MAX_NEEDLE = 256
const posBuf = new Int32Array(MAX_NEEDLE)

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private charBits: Int32Array = new Int32Array(0)
  private pathLens: Int32Array = new Int32Array(0)
  private readyCount = 0
  private buildId = 0

  /**
   * Synchronously populate the index from a list of file paths.
   */
  loadFromFileList(fileList: string[]): void {
    this.buildId++
    const n = fileList.length
    this.paths = fileList.slice()
    this.lowerPaths = new Array<string>(n)
    this.charBits = new Int32Array(n)
    this.pathLens = new Int32Array(n)
    this.processRange(0, n)
    this.readyCount = n
  }

  /**
   * Asynchronously populate the index in 4ms time-sliced chunks so large
   * repositories (100k+ files) never block UI rendering or key input.
   */
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>
    done: Promise<void>
  } {
    const id = ++this.buildId
    const n = fileList.length
    this.paths = fileList.slice()
    this.lowerPaths = new Array<string>(n)
    this.charBits = new Int32Array(n)
    this.pathLens = new Int32Array(n)
    this.readyCount = 0

    let resolveQueryable!: () => void
    const queryable = new Promise<void>(resolve => {
      resolveQueryable = resolve
    })

    const done = (async () => {
      let cursor = 0
      let signaledQueryable = false
      while (cursor < n) {
        if (this.buildId !== id) {
          if (!signaledQueryable) resolveQueryable()
          return
        }
        const deadline = performance.now() + CHUNK_MS
        while (cursor < n) {
          const end = Math.min(cursor + BATCH_SIZE, n)
          this.processRange(cursor, end)
          cursor = end
          this.readyCount = cursor
          if (performance.now() >= deadline) break
        }
        if (!signaledQueryable) {
          signaledQueryable = true
          resolveQueryable()
        }
        if (cursor < n) {
          await yieldToEventLoop()
        }
      }
      if (!signaledQueryable) {
        resolveQueryable()
      }
    })()

    return { queryable, done }
  }

  /**
   * Number of indexed entries currently searchable.
   */
  size(): number {
    return this.readyCount
  }

  private processRange(start: number, end: number): void {
    const { paths, lowerPaths, charBits, pathLens } = this
    for (let i = start; i < end; i++) {
      const p = paths[i]!
      const lower = p.toLowerCase()
      lowerPaths[i] = lower
      pathLens[i] = p.length
      let bits = 0
      for (let j = 0; j < lower.length; j++) {
        const c = lower.charCodeAt(j)
        if (c >= 97 && c <= 122) {
          bits |= 1 << (c - 97)
        }
      }
      charBits[i] = bits
    }
  }

  /**
   * Fuzzy search indexed file paths, returning up to `limit` results ordered best-first.
   */
  search(query: string, limit: number): SearchResult[] {
    if (limit <= 0 || this.readyCount === 0) return []

    const trimmed = query.trim()
    if (trimmed.length === 0) {
      return computeTopLevelEntries(this.paths, this.readyCount, limit)
    }

    // Smart-case: uppercase letter in query enables case-sensitive matching
    let caseSensitive = false
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed.charCodeAt(i)
      if (c >= 65 && c <= 90) {
        caseSensitive = true
        break
      }
    }

    const needle = caseSensitive ? trimmed : trimmed.toLowerCase()
    const nLen = Math.min(needle.length, MAX_NEEDLE)
    const needleChars: string[] = new Array(nLen)
    let needleBitmap = 0

    for (let j = 0; j < nLen; j++) {
      const ch = needle[j]!
      needleChars[j] = ch
      const lowerCode = ch.toLowerCase().charCodeAt(0)
      if (lowerCode >= 97 && lowerCode <= 122) {
        needleBitmap |= 1 << (lowerCode - 97)
      }
    }

    const scoreCeiling = nLen * MAX_CHAR_SCORE + 32
    const topK: { path: string; fuzzScore: number }[] = []
    let threshold = -Infinity

    const { paths, lowerPaths, charBits, pathLens, readyCount } = this

    outer: for (let i = 0; i < readyCount; i++) {
      // O(1) 26-bit letter bitmap prefilter
      if ((charBits[i]! & needleBitmap) !== needleBitmap) continue

      const haystack = caseSensitive ? paths[i]! : lowerPaths[i]!

      let pos = haystack.indexOf(needleChars[0]!)
      if (pos === -1) continue
      posBuf[0] = pos
      let gapPenalty = 0
      let consecBonus = 0
      let prev = pos

      for (let j = 1; j < nLen; j++) {
        pos = haystack.indexOf(needleChars[j]!, prev + 1)
        if (pos === -1) continue outer
        posBuf[j] = pos
        const gap = pos - prev - 1
        if (gap === 0) {
          consecBonus += BONUS_CONSECUTIVE
        } else {
          gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION
        }
        prev = pos
      }

      if (
        topK.length === limit &&
        scoreCeiling + consecBonus - gapPenalty <= threshold
      ) {
        continue
      }

      const path = paths[i]!
      const hLen = pathLens[i]!
      let score = nLen * SCORE_MATCH + consecBonus - gapPenalty
      score += scoreBonusAt(path, posBuf[0]!, true)
      for (let j = 1; j < nLen; j++) {
        score += scoreBonusAt(path, posBuf[j]!, false)
      }
      score += Math.max(0, 32 - (hLen >> 2))

      if (topK.length < limit) {
        topK.push({ path, fuzzScore: score })
        if (topK.length === limit) {
          topK.sort((a, b) => a.fuzzScore - b.fuzzScore)
          threshold = topK[0]!.fuzzScore
        }
      } else if (score > threshold) {
        let lo = 0
        let hi = topK.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (topK[mid]!.fuzzScore < score) lo = mid + 1
          else hi = mid
        }
        topK.splice(lo, 0, { path, fuzzScore: score })
        topK.shift()
        threshold = topK[0]!.fuzzScore
      }
    }

    topK.sort((a, b) => b.fuzzScore - a.fuzzScore)

    const matchCount = topK.length
    const denom = Math.max(matchCount, 1)
    const results: SearchResult[] = new Array(matchCount)

    for (let i = 0; i < matchCount; i++) {
      const path = topK[i]!.path
      const positionScore = i / denom
      // Slight 1.05x penalty for test paths so source files rank higher on ties
      const finalScore = path.includes('test')
        ? Math.min(positionScore * 1.05, 1.0)
        : positionScore
      results[i] = { path, score: finalScore }
    }

    return results
  }
}

function scoreBonusAt(path: string, pos: number, first: boolean): number {
  if (pos === 0) return first ? BONUS_FIRST_CHAR : 0
  const prevCh = path.charCodeAt(pos - 1)
  if (isBoundary(prevCh)) return BONUS_BOUNDARY
  if (isLower(prevCh) && isUpper(path.charCodeAt(pos))) return BONUS_CAMEL
  return 0
}

function isBoundary(code: number): boolean {
  return (
    code === 47 || // /
    code === 92 || // \
    code === 45 || // -
    code === 95 || // _
    code === 46 || // .
    code === 32 // space
  )
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function computeTopLevelEntries(
  paths: string[],
  readyCount: number,
  limit: number,
): SearchResult[] {
  const topLevel = new Set<string>()
  for (let idx = 0; idx < readyCount; idx++) {
    const p = paths[idx]!
    let end = p.length
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      if (c === 47 || c === 92) {
        end = i
        break
      }
    }
    const segment = p.slice(0, end)
    if (segment.length > 0) {
      topLevel.add(segment)
      if (topLevel.size >= limit) break
    }
  }

  const sorted = Array.from(topLevel)
  sorted.sort((a, b) => {
    const lenDiff = a.length - b.length
    if (lenDiff !== 0) return lenDiff
    return a < b ? -1 : a > b ? 1 : 0
  })

  return sorted.slice(0, limit).map(path => ({ path, score: 0.0 }))
}

export type FileIndexType = FileIndex
