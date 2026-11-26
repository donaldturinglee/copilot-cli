import { open, readFile, stat } from 'fs/promises'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
} from 'jsonc-parser/lib/esm/main.js'
import { stripBom } from './json_read.js'
import { logError } from './log.js'
import { memoizeWithLru } from './memoize.js'
import { jsonStringify } from './slow_operations.js'

type CachedParse = { ok: true; value: unknown } | { ok: false }

const PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024

function parseJsonUncached(json: string, shouldLogError: boolean): CachedParse {
  try {
    return { ok: true, value: JSON.parse(stripBom(json)) }
  } catch (error) {
    if (shouldLogError) {
      logError(error)
    }
    return { ok: false }
  }
}

const parseJsonCached = memoizeWithLru(parseJsonUncached, json => json, 50)

/**
 * Safely parses JSON with an LRU-bounded cache for small inputs (<= 8 KiB).
 * Returns null on invalid or empty input.
 */
export const safeParseJson = Object.assign(
  function safeParseJson(
    json: string | null | undefined,
    shouldLogError = true,
  ): unknown {
    if (!json) return null
    const result =
      json.length > PARSE_CACHE_MAX_KEY_BYTES
        ? parseJsonUncached(json, shouldLogError)
        : parseJsonCached(json, shouldLogError)
    return result.ok ? result.value : null
  },
  { cache: parseJsonCached.cache },
)

/**
 * Safely parses JSON with comments (JSONC), stripping any UTF-8 BOM first.
 */
export function safeParseJsonc(json: string | null | undefined): unknown {
  if (!json) {
    return null
  }
  try {
    return parseJsonc(stripBom(json))
  } catch (error) {
    logError(error)
    return null
  }
}

type BunJsonlParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }

const bunJsonlParse: BunJsonlParseChunk | false = (() => {
  if (typeof Bun === 'undefined') return false
  const bunGlobal = Bun as unknown as Record<string, unknown>
  const jsonl = bunGlobal.JSONL as Record<string, unknown> | undefined
  if (!jsonl?.parseChunk) return false
  return jsonl.parseChunk as BunJsonlParseChunk
})()

function parseJsonlBun<Item>(rawData: string | Buffer): Item[] {
  const data =
    typeof rawData === 'string'
      ? stripBom(rawData)
      : rawData[0] === 0xef && rawData[1] === 0xbb && rawData[2] === 0xbf
        ? rawData.subarray(3)
        : rawData
  const parse = bunJsonlParse as BunJsonlParseChunk
  const length = data.length
  const result = parse(data)
  if (!result.error || result.done || result.read >= length) {
    return result.values as Item[]
  }
  let values = result.values as Item[]
  let offset = result.read
  while (offset < length) {
    const newlineIndex =
      typeof data === 'string'
        ? data.indexOf('\n', offset)
        : data.indexOf(0x0a, offset)
    if (newlineIndex === -1) break
    offset = newlineIndex + 1
    const next = parse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values as Item[])
    }
    if (!next.error || next.done || next.read >= length) break
    offset = next.read
  }
  return values
}

function parseJsonlBuffer<Item>(buffer: Buffer): Item[] {
  const bufferLength = buffer.length
  let start = 0

  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    start = 3
  }

  const results: Item[] = []
  while (start < bufferLength) {
    let end = buffer.indexOf(0x0a, start)
    if (end === -1) end = bufferLength

    const line = buffer.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as Item)
    } catch {
      // Skip malformed lines
    }
  }
  return results
}

function parseJsonlString<Item>(data: string): Item[] {
  const stripped = stripBom(data)
  const length = stripped.length
  let start = 0

  const results: Item[] = []
  while (start < length) {
    let end = stripped.indexOf('\n', start)
    if (end === -1) end = length

    const line = stripped.substring(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as Item)
    } catch {
      // Skip malformed lines
    }
  }
  return results
}

/**
 * Parses JSONL data from a string or Buffer, skipping malformed lines.
 * Uses Bun.JSONL.parseChunk when available for better performance.
 */
export function parseJsonl<Item>(data: string | Buffer): Item[] {
  if (bunJsonlParse) {
    return parseJsonlBun<Item>(data)
  }
  if (typeof data === 'string') {
    return parseJsonlString<Item>(data)
  }
  return parseJsonlBuffer<Item>(data)
}

const MAX_JSONL_READ_BYTES = 100 * 1024 * 1024

/**
 * Reads and parses a JSONL file, reading at most the last 100 MiB.
 * For files larger than 100 MiB, reads the tail and skips the first partial line.
 */
export async function readJsonlFile<Item>(filePath: string): Promise<Item[]> {
  const { size } = await stat(filePath)
  if (size <= MAX_JSONL_READ_BYTES) {
    return parseJsonl<Item>(await readFile(filePath))
  }
  const fileHandle = await open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(MAX_JSONL_READ_BYTES)
    let totalRead = 0
    const fileOffset = size - MAX_JSONL_READ_BYTES
    while (totalRead < MAX_JSONL_READ_BYTES) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        totalRead,
        MAX_JSONL_READ_BYTES - totalRead,
        fileOffset + totalRead,
      )
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
    const newlineIndex = buffer.indexOf(0x0a)
    if (newlineIndex !== -1 && newlineIndex < totalRead - 1) {
      return parseJsonl<Item>(buffer.subarray(newlineIndex + 1, totalRead))
    }
    return parseJsonl<Item>(buffer.subarray(0, totalRead))
  } finally {
    await fileHandle.close()
  }
}

/**
 * Modifies a JSONC string by appending a new item to a top-level array,
 * preserving existing comments and formatting when possible.
 */
export function addItemToJsoncArray(
  content: string,
  newItem: unknown,
): string {
  try {
    if (!content || content.trim() === '') {
      return jsonStringify([newItem], null, 4)
    }

    const cleanContent = stripBom(content)
    const parsedContent = parseJsonc(cleanContent)

    if (Array.isArray(parsedContent)) {
      const arrayLength = parsedContent.length
      const insertPath = arrayLength === 0 ? [0] : [arrayLength]

      const edits = modify(cleanContent, insertPath, newItem, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
        isArrayInsertion: true,
      })

      if (!edits || edits.length === 0) {
        return jsonStringify([...parsedContent, newItem], null, 4)
      }

      return applyEdits(cleanContent, edits)
    }

    return jsonStringify([newItem], null, 4)
  } catch (error) {
    logError(error)
    return jsonStringify([newItem], null, 4)
  }
}
