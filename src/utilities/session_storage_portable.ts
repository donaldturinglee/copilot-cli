/**
 * Portable JSONL session-storage helpers:
 * - Path canonicalization and Bun/Node hash-mismatch project-dir lookup
 * - 64KB head/tail zero-parse scanning (`readSessionLite`, `readHeadAndTail`)
 * - Single-pass chunked transcript loading (`readTranscriptForLoad`) with
 *   pre-compact boundary truncation and attribution-snapshot deduplication
 */

import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { open, readdir, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './env_utils.js'
import { listExistingWorktreePaths } from './get_worktree_paths_portable.js'
import { MAX_SANITIZED_LENGTH, sanitizePath } from './path.js'

export const LITE_READ_BUF_SIZE = 65_536
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024
export const TRANSCRIPT_READ_CHUNK_SIZE = 1024 * 1024
export const BOUNDARY_SEARCH_BOUND = 256

const ATTRIBUTION_PREFIX = Buffer.from('{"type":"attribution-snapshot"')
const COMPACT_BOUNDARY_NEEDLE = Buffer.from('"compact_boundary"')
const SYSTEM_PREFIX = Buffer.from('{"type":"system"')

export const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

export interface LiteSessionRead {
  mtime: number
  size: number
  head: string
  tail: string
}

export interface ReadTranscriptForLoadResult {
  buffer: Buffer
  boundaryStartOffset: number
  hasPreservedSegment: boolean
  skippedAttributionSnapshots: number
}

/**
 * Returns the root `~/.copilot/projects` directory.
 */
export function getProjectsDirPortable(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

/**
 * Canonicalizes a filesystem path via `realpath` + NFC normalization, falling
 * back to NFC-normalized input if the path cannot be resolved.
 */
export async function canonicalizePath(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}

/**
 * Finds the persisted project directory for `projectPath`, recovering from
 * Bun (`wyhash`) vs Node (`djb2`) suffix differences on paths exceeding 200 chars.
 */
export async function findProjectDir(
  projectPath: string,
): Promise<string | null> {
  const projectsDir = getProjectsDirPortable()
  const sanitized = sanitizePath(projectPath)
  const exact = join(projectsDir, sanitized)

  try {
    const info = await stat(exact)
    if (info.isDirectory()) {
      return exact
    }
  } catch {
    // Try fallback prefix match below
  }

  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return null
  }

  const prefix = `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        return join(projectsDir, entry.name)
      }
    }
  } catch {
    // Projects dir missing
  }
  return null
}

/**
 * Locates `<sessionId>.jsonl` for a specific `dir` (checking sibling worktrees)
 * or across all project directories when `dir` is omitted. Ignores 0-byte files.
 */
export async function resolveSessionFilePath(
  sessionId: string,
  dir?: string,
): Promise<string | null> {
  const filename = `${sessionId}.jsonl`

  const checkDir = async (projectDir: string | null): Promise<string | null> => {
    if (!projectDir) return null
    const candidate = join(projectDir, filename)
    try {
      const st = await stat(candidate)
      if (st.isFile() && st.size > 0) {
        return candidate
      }
    } catch {
      // Not found
    }
    return null
  }

  if (dir) {
    const canonical = await canonicalizePath(dir)
    const directHit = await checkDir(await findProjectDir(canonical))
    if (directHit) {
      return directHit
    }

    const worktrees = listExistingWorktreePaths(canonical)
    for (const wt of worktrees) {
      if (wt === canonical) continue
      const wtHit = await checkDir(await findProjectDir(wt))
      if (wtHit) {
        return wtHit
      }
    }
    return null
  }

  const projectsDir = getProjectsDirPortable()
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const hit = await checkDir(join(projectsDir, entry.name))
      if (hit) {
        return hit
      }
    }
  } catch {
    // Projects dir absent
  }
  return null
}

/**
 * Reads the first 64KB and last 64KB of `filePath` using a caller-supplied
 * reusable buffer (`buf`) to avoid per-file allocations while scanning hundreds
 * of sessions.
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<{ head: string; tail: string }> {
  if (fileSize <= 0) {
    return { head: '', tail: '' }
  }
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(filePath, 'r')
    const headLen = Math.min(fileSize, buf.length)
    const headRead = await fh.read(buf, 0, headLen, 0)
    const head = buf.toString('utf8', 0, headRead.bytesRead)

    if (fileSize <= buf.length) {
      return { head, tail: head }
    }

    const tailOffset = Math.max(0, fileSize - buf.length)
    const tailLen = Math.min(fileSize - tailOffset, buf.length)
    const tailRead = await fh.read(buf, 0, tailLen, tailOffset)
    const tail = buf.toString('utf8', 0, tailRead.bytesRead)
    return { head, tail }
  } catch {
    return { head: '', tail: '' }
  } finally {
    if (fh) {
      await fh.close().catch(() => {})
    }
  }
}

/**
 * Synchronously reads up to the last `maxBytes` (default 64KB) of `filePath`.
 */
export function readFileTailSync(
  filePath: string,
  maxBytes: number = LITE_READ_BUF_SIZE,
): string {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const st = fstatSync(fd)
    if (st.size <= 0) {
      return ''
    }
    const len = Math.min(st.size, maxBytes)
    const offset = Math.max(0, st.size - len)
    const buf = Buffer.allocUnsafe(len)
    const bytesRead = readSync(fd, buf, 0, len, offset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Concurrency-safe 64KB head/tail reader returning `{ mtime, size, head, tail }`
 * or `null` if the file is empty or unreadable.
 */
export async function readSessionLite(
  filePath: string,
): Promise<LiteSessionRead | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(filePath, 'r')
    const st = await fh.stat()
    if (!st.isFile() || st.size <= 0) {
      return null
    }
    const buf = Buffer.allocUnsafe(Math.min(st.size, LITE_READ_BUF_SIZE))
    const headRead = await fh.read(buf, 0, buf.length, 0)
    const head = buf.toString('utf8', 0, headRead.bytesRead)
    let tail = head
    if (st.size > LITE_READ_BUF_SIZE) {
      const tailOffset = st.size - LITE_READ_BUF_SIZE
      const tailRead = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
      tail = buf.toString('utf8', 0, tailRead.bytesRead)
    }
    return {
      mtime: st.mtimeMs,
      size: st.size,
      head,
      tail,
    }
  } catch {
    return null
  } finally {
    if (fh) {
      await fh.close().catch(() => {})
    }
  }
}

function readJsonStringAt(text: string, quoteStart: number): string | undefined {
  let i = quoteStart + 1
  let hasEscape = false
  while (i < text.length) {
    const ch = text.charCodeAt(i)
    if (ch === 0x5c) {
      // Backslash escape
      hasEscape = true
      i += 2
      continue
    }
    if (ch === 0x22) {
      // Closing double quote
      const raw = text.slice(quoteStart + 1, i)
      if (!hasEscape) {
        return raw
      }
      try {
        return JSON.parse(`"${raw}"`) as string
      } catch {
        return raw
      }
    }
    i++
  }
  return undefined
}

/**
 * Zero-parse extraction of the first string value for `"key":"..."` or
 * `"key": "..."` in a JSONL text chunk (tolerant of truncated 64KB boundaries).
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const needles = [`"${key}":"`, `"${key}": "`]
  let bestIdx = -1
  let bestQuotePos = -1

  for (const needle of needles) {
    const idx = text.indexOf(needle)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx
      bestQuotePos = idx + needle.length - 1
    }
  }
  if (bestQuotePos === -1) {
    return undefined
  }
  return readJsonStringAt(text, bestQuotePos)
}

/**
 * Zero-parse extraction of the LAST string value for `"key":"..."` or
 * `"key": "..."` in a JSONL text chunk.
 */
export function extractLastJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const needles = [`"${key}":"`, `"${key}": "`]
  let bestIdx = -1
  let bestQuotePos = -1

  for (const needle of needles) {
    const idx = text.lastIndexOf(needle)
    if (idx > bestIdx) {
      bestIdx = idx
      bestQuotePos = idx + needle.length - 1
    }
  }
  if (bestQuotePos === -1) {
    return undefined
  }
  return readJsonStringAt(text, bestQuotePos)
}

/**
 * Extracts up to `maxLen` characters of a JSON string field even if its closing
 * quote was cut off past the 64KB head window.
 */
export function extractJsonStringFieldPrefix(
  text: string,
  key: string,
  maxLen: number,
): string | undefined {
  const needles = [`"${key}":"`, `"${key}": "`]
  let quotePos = -1
  for (const needle of needles) {
    const idx = text.indexOf(needle)
    if (idx !== -1 && (quotePos === -1 || idx < quotePos)) {
      quotePos = idx + needle.length - 1
    }
  }
  if (quotePos === -1) {
    return undefined
  }

  let out = ''
  let i = quotePos + 1
  while (i < text.length && out.length < maxLen) {
    const ch = text[i]!
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) break
      if (next === 'n' || next === 'r' || next === 't') {
        out += ' '
      } else if (next === '"' || next === '\\' || next === '/') {
        out += next
      } else {
        out += next
      }
      i += 2
      continue
    }
    if (ch === '"') {
      break
    }
    out += ch === '\n' || ch === '\r' || ch === '\t' ? ' ' : ch
    i++
  }

  const trimmed = out.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function truncatePromptText(text: string, maxLen = 200): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= maxLen) {
    return flattened
  }
  return `${flattened.slice(0, maxLen)}\u2026`
}

function extractXmlTagContent(text: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = text.indexOf(open)
  if (start === -1) return null
  const end = text.indexOf(close, start + open.length)
  if (end === -1) return null
  return text.slice(start + open.length, end).trim()
}

/**
 * Scans the 64KB head chunk of a session JSONL for the first meaningful user
 * prompt, handling array text blocks, `<bash-input>`, `<command-name>`, and
 * filtering out meta / compact-summary / synthetic XML messages.
 */
export function extractFirstPromptFromHead(
  head: string,
  options?: {
    builtInCommandNames?: ReadonlySet<string>
    keepCustomCommandWithArgs?: boolean
    proactiveTickFallback?: boolean
  },
): string | undefined {
  const lines = head.split('\n')
  let commandFallback: string | undefined
  let sawTick = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || !line.startsWith('{')) continue
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue
    }
    if (
      line.includes('"tool_result"') ||
      line.includes('"isMeta":true') ||
      line.includes('"isMeta": true') ||
      line.includes('"isCompactSummary":true') ||
      line.includes('"isCompactSummary": true')
    ) {
      continue
    }

    let parsed: {
      type?: string
      isMeta?: boolean
      isCompactSummary?: boolean
      message?: { content?: unknown }
    }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      continue
    }
    if (
      parsed.type !== 'user' ||
      parsed.isMeta ||
      parsed.isCompactSummary ||
      !parsed.message
    ) {
      continue
    }

    const content = parsed.message.content
    const candidates: string[] = []
    if (typeof content === 'string') {
      candidates.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          candidates.push((block as { text: string }).text)
        }
      }
    }

    for (const rawText of candidates) {
      const text = rawText.trim()
      if (!text) continue

      if (text.includes('<tick>')) {
        sawTick = true
        continue
      }

      const bashInput = extractXmlTagContent(text, 'bash-input')
      if (bashInput) {
        return truncatePromptText(`! ${bashInput}`)
      }

      const cmdName = extractXmlTagContent(text, 'command-name')
      if (cmdName) {
        const cmdArgs = extractXmlTagContent(text, 'command-args') ?? ''
        const normalizedName = cmdName.replace(/^\//, '')
        const isBuiltIn = options?.builtInCommandNames?.has(normalizedName)
        if (options?.keepCustomCommandWithArgs && !isBuiltIn && cmdArgs) {
          return truncatePromptText(`${cmdName} ${cmdArgs}`)
        }
        if (!commandFallback) {
          commandFallback = cmdArgs ? `${cmdName} ${cmdArgs}` : cmdName
        }
        continue
      }

      if (SKIP_FIRST_PROMPT_PATTERN.test(text)) {
        continue
      }

      return truncatePromptText(text)
    }
  }

  if (commandFallback) {
    return truncatePromptText(commandFallback)
  }
  if (options?.proactiveTickFallback && sawTick) {
    return 'Proactive session'
  }
  return undefined
}

function startsWithBufferAt(
  buf: Buffer,
  offset: number,
  end: number,
  prefix: Buffer,
): boolean {
  if (end - offset < prefix.length) {
    return false
  }
  return buf.compare(prefix, 0, prefix.length, offset, offset + prefix.length) === 0
}

function parseBoundaryLine(
  lineBuf: Buffer,
): { isCompactBoundary: boolean; hasPreservedSegment: boolean } {
  try {
    const parsed = JSON.parse(lineBuf.toString('utf8')) as {
      type?: unknown
      subtype?: unknown
      compactMetadata?: { preservedSegment?: unknown }
    }
    if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
      return {
        isCompactBoundary: true,
        hasPreservedSegment: Boolean(parsed.compactMetadata?.preservedSegment),
      }
    }
  } catch {
    // Malformed line
  }
  return { isCompactBoundary: false, hasPreservedSegment: false }
}

class GrowableBuffer {
  buf: Buffer
  len = 0
  private readonly maxCap: number

  constructor(initialCap: number, maxCap: number) {
    this.buf = Buffer.allocUnsafe(Math.max(1024, initialCap))
    this.maxCap = Math.max(1024, maxCap)
  }

  reset(): void {
    this.len = 0
  }

  appendSlice(src: Buffer, start: number, end: number): void {
    const sliceLen = end - start
    if (sliceLen <= 0) return
    if (this.len + sliceLen > this.buf.length) {
      let nextCap = this.buf.length
      while (nextCap < this.len + sliceLen) {
        nextCap = Math.min(this.maxCap, Math.max(nextCap * 2, this.len + sliceLen))
        if (nextCap >= this.len + sliceLen) break
      }
      const next = Buffer.allocUnsafe(Math.max(nextCap, this.len + sliceLen))
      this.buf.copy(next, 0, 0, this.len)
      this.buf = next
    }
    src.copy(this.buf, this.len, start, end)
    this.len += sliceLen
  }

  appendByte(byte: number): void {
    const one = Buffer.from([byte])
    this.appendSlice(one, 0, 1)
  }

  toBuffer(): Buffer {
    return this.buf.subarray(0, this.len)
  }
}

/**
 * Single-pass forward 1MB chunked transcript loader for large (`>5MB`) files:
 * - Drops all `attribution-snapshot` lines inline while keeping only the latest
 *   one to append at EOF.
 * - On encountering a `compact_boundary` without `preservedSegment`, discards
 *   all accumulated pre-compact bytes and records `boundaryStartOffset`.
 */
export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<ReadTranscriptForLoadResult> {
  const out = new GrowableBuffer(
    Math.min(fileSize + 1, 8 * 1024 * 1024),
    fileSize + 2,
  )
  const chunk = Buffer.allocUnsafe(TRANSCRIPT_READ_CHUNK_SIZE)
  let carry: Buffer = Buffer.alloc(0)
  let carryFileOffset = 0
  let boundaryStartOffset = 0
  let hasPreservedSegment = false
  const lastSnapHolder: { buf: Buffer | null } = { buf: null }
  let skippedAttributionSnapshots = 0

  const handleCompleteLine = (lineBuf: Buffer, lineFileOffset: number): void => {
    const lineLen = lineBuf.length
    if (lineLen === 0) {
      return
    }

    // 1. Attribution-snapshot stripping (keep only latest snapshot)
    if (startsWithBufferAt(lineBuf, 0, lineLen, ATTRIBUTION_PREFIX)) {
      if (lastSnapHolder.buf !== null) {
        skippedAttributionSnapshots++
      }
      lastSnapHolder.buf = Buffer.from(lineBuf)
      return
    }

    // 2. Compact boundary truncation check (bounded to first 256 bytes or system prefix)
    const searchBound = Math.min(lineLen, BOUNDARY_SEARCH_BOUND)
    const looksLikeBoundary =
      startsWithBufferAt(lineBuf, 0, lineLen, SYSTEM_PREFIX) ||
      lineBuf.subarray(0, searchBound).includes(COMPACT_BOUNDARY_NEEDLE)
    if (looksLikeBoundary && lineBuf.includes(COMPACT_BOUNDARY_NEEDLE)) {
      const hit = parseBoundaryLine(lineBuf)
      if (hit.isCompactBoundary) {
        if (!hit.hasPreservedSegment) {
          out.reset()
          boundaryStartOffset = lineFileOffset
          hasPreservedSegment = false
          lastSnapHolder.buf = null
        } else {
          hasPreservedSegment = true
        }
      }
    }

    out.appendSlice(lineBuf, 0, lineLen)
    out.appendByte(0x0a)
  }

  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(filePath, 'r')
    let filePos = 0
    while (filePos < fileSize) {
      const { bytesRead } = await fh.read(
        chunk,
        0,
        TRANSCRIPT_READ_CHUNK_SIZE,
        filePos,
      )
      if (bytesRead <= 0) break

      let cursor = 0
      if (carry.length > 0) {
        const nlInChunk = chunk.indexOf(0x0a, 0)
        if (nlInChunk !== -1 && nlInChunk < bytesRead) {
          const fullLine = Buffer.concat([carry, chunk.subarray(0, nlInChunk)])
          handleCompleteLine(fullLine, carryFileOffset)
          carry = Buffer.alloc(0)
          cursor = nlInChunk + 1
        } else {
          carry = Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          filePos += bytesRead
          continue
        }
      }

      while (cursor < bytesRead) {
        const nlIdx = chunk.indexOf(0x0a, cursor)
        if (nlIdx === -1 || nlIdx >= bytesRead) {
          carry = Buffer.from(chunk.subarray(cursor, bytesRead))
          carryFileOffset = filePos + cursor
          break
        }
        handleCompleteLine(chunk.subarray(cursor, nlIdx), filePos + cursor)
        cursor = nlIdx + 1
      }

      filePos += bytesRead
    }

    if (carry.length > 0) {
      handleCompleteLine(carry, carryFileOffset)
    }

    if (lastSnapHolder.buf && lastSnapHolder.buf.length > 0) {
      if (out.len > 0 && out.buf[out.len - 1] !== 0x0a) {
        out.appendByte(0x0a)
      }
      out.appendSlice(lastSnapHolder.buf, 0, lastSnapHolder.buf.length)
      out.appendByte(0x0a)
    }
  } finally {
    if (fh) {
      await fh.close().catch(() => {})
    }
  }

  return {
    buffer: out.toBuffer(),
    boundaryStartOffset,
    hasPreservedSegment,
    skippedAttributionSnapshots,
  }
}
