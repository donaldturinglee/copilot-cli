/**
 * Dual-path (fast in-memory <10MB / streaming >=10MB) line-range file reader
 * with UTF-8 BOM stripping, CRLF normalization, mtime capture, and byte-limit
 * line-boundary truncation.
 */

import { createReadStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { detectFileEncoding } from './file.js'

const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

export class FileTooLargeError extends Error {
  readonly filePath: string
  readonly size: number
  readonly maxSizeBytes: number

  constructor(filePath: string, size: number, maxSizeBytes: number) {
    super(
      `File content (${Math.round(size / 1024)}KB) exceeds maximum allowed size (${Math.round(maxSizeBytes / 1024)}KB). Use offset and limit parameters to read specific portions of the file.`,
    )
    this.name = 'FileTooLargeError'
    this.filePath = filePath
    this.size = size
    this.maxSizeBytes = maxSizeBytes
  }
}

export interface ReadFileInRangeOptions {
  /** 1-based starting line number (default 1). */
  offset?: number
  /** Maximum number of lines to return. */
  limit?: number
  /** Maximum byte size for full read when no offset/limit is given, or byte cap for truncation. */
  maxSizeBytes?: number
  /** When true, stop collecting lines once `maxSizeBytes` is reached instead of throwing. */
  truncateOnByteLimit?: boolean
  /** Optional explicit encoding override. */
  encoding?: BufferEncoding
}

export interface ReadFileInRangeResult {
  content: string
  lineCount: number
  totalLines: number
  bytesRead: number
  truncatedByBytes: boolean
  mtimeMs: number
  encoding: BufferEncoding
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function sliceLinesWithByteBudget(
  lines: readonly string[],
  startIndex: number,
  limit: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
): { selected: string[]; bytesRead: number; truncatedByBytes: boolean } {
  const endIndex =
    limit !== undefined
      ? Math.min(lines.length, startIndex + limit)
      : lines.length
  const selected: string[] = []
  let bytesRead = 0
  let truncatedByBytes = false

  for (let i = startIndex; i < endIndex; i++) {
    const line = lines[i]!
    const lineBytes =
      Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0)
    if (
      truncateOnByteLimit &&
      maxBytes !== undefined &&
      selected.length > 0 &&
      bytesRead + lineBytes > maxBytes
    ) {
      truncatedByBytes = true
      break
    }
    selected.push(line)
    bytesRead += lineBytes
  }

  return { selected, bytesRead, truncatedByBytes }
}

async function readFileStreaming(
  filePath: string,
  startLine: number,
  limit: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  encoding: BufferEncoding,
  mtimeMs: number,
): Promise<ReadFileInRangeResult> {
  const selected: string[] = []
  let lineNumber = 0
  let bytesRead = 0
  let truncatedByBytes = false
  let stoppedEarly = false

  const stream = createReadStream(filePath, { encoding })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (let line of rl) {
      lineNumber++
      if (lineNumber === 1) {
        line = stripBom(line)
      }
      if (lineNumber < startLine) {
        continue
      }
      if (limit !== undefined && selected.length >= limit) {
        stoppedEarly = true
        break
      }
      const lineBytes =
        Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0)
      if (
        truncateOnByteLimit &&
        maxBytes !== undefined &&
        selected.length > 0 &&
        bytesRead + lineBytes > maxBytes
      ) {
        truncatedByBytes = true
        stoppedEarly = true
        break
      }
      selected.push(line)
      bytesRead += lineBytes
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return {
    content: selected.join('\n'),
    lineCount: selected.length,
    totalLines: stoppedEarly ? lineNumber : lineNumber,
    bytesRead,
    truncatedByBytes,
    mtimeMs,
    encoding,
  }
}

/**
 * Reads a line range from `filePath`, selecting fast in-memory reads under
 * 10 MB and streaming reads for larger files.
 */
export async function readFileInRange(
  filePath: string,
  options: ReadFileInRangeOptions = {},
): Promise<ReadFileInRangeResult> {
  const stats = await stat(filePath)
  const mtimeMs = Math.floor(stats.mtimeMs)
  const encoding = options.encoding ?? detectFileEncoding(filePath)
  const startLine = Math.max(1, options.offset ?? 1)
  const hasRange = options.offset !== undefined || options.limit !== undefined
  const truncateOnByteLimit = Boolean(options.truncateOnByteLimit)

  if (
    !hasRange &&
    !truncateOnByteLimit &&
    options.maxSizeBytes !== undefined &&
    stats.size > options.maxSizeBytes
  ) {
    throw new FileTooLargeError(filePath, stats.size, options.maxSizeBytes)
  }

  if (stats.size >= FAST_PATH_MAX_BYTES) {
    return readFileStreaming(
      filePath,
      startLine,
      options.limit,
      options.maxSizeBytes,
      truncateOnByteLimit,
      encoding,
      mtimeMs,
    )
  }

  const raw = await readFile(filePath, { encoding })
  const normalized = stripBom(raw).replace(/\r\n/g, '\n')
  if (normalized.length === 0) {
    return {
      content: '',
      lineCount: 0,
      totalLines: 0,
      bytesRead: 0,
      truncatedByBytes: false,
      mtimeMs,
      encoding,
    }
  }

  const allLines = normalized.split('\n')
  // Preserve trailing newline semantics: "a\nb\n" has 2 logical lines, not 3
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
    allLines.pop()
  }
  const totalLines = allLines.length
  const startIndex = startLine - 1

  if (startIndex >= totalLines) {
    return {
      content: '',
      lineCount: 0,
      totalLines,
      bytesRead: 0,
      truncatedByBytes: false,
      mtimeMs,
      encoding,
    }
  }

  const { selected, bytesRead, truncatedByBytes } = sliceLinesWithByteBudget(
    allLines,
    startIndex,
    options.limit,
    options.maxSizeBytes,
    truncateOnByteLimit,
  )

  return {
    content: selected.join('\n'),
    lineCount: selected.length,
    totalLines,
    bytesRead,
    truncatedByBytes,
    mtimeMs,
    encoding,
  }
}
