/**
 * Ripgrep wrapper (`ripGrep`, `ripGrepStream`, `countFilesRoundedRg`) with a
 * full pure-TypeScript fallback walker/regex engine when `rg` is not installed
 * on the host PATH.
 */

import { spawn } from 'child_process'
import { open, readdir, readFile, stat } from 'fs/promises'
import ignore from 'ignore'
import { extname, join, relative, resolve } from 'path'
import picomatch from 'picomatch'
import {
  embeddedSearchToolsBinaryPath,
  hasEmbeddedSearchTools,
} from './embedded_tools.js'
import { isEnvTruthy } from './env_utils.js'
import { getPlatform } from './platform.js'
import { whichSync } from './which.js'

const DEFAULT_RG_TIMEOUT_MS = 20_000
const MAX_FALLBACK_FILE_BYTES = 5 * 1024 * 1024
const BINARY_CHECK_BYTES = 4096

export class RipgrepTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Search timed out after ${Math.round(timeoutMs / 1000)}s.`)
    this.name = 'RipgrepTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface RipgrepConfig {
  timeoutMs?: number
  maxLines?: number
  cwd?: string
  /** Force pure-TS fallback (useful for deterministic testing). */
  forceFallback?: boolean
}

let cachedRgCommand: { command: string; mode: 'embedded' | 'system' } | null | undefined

/**
 * Resolves the `rg` executable command (embedded or system PATH) or `null`
 * if ripgrep is unavailable on this host.
 */
export function ripgrepCommand(): {
  command: string
  mode: 'embedded' | 'system'
} | null {
  if (cachedRgCommand !== undefined) {
    return cachedRgCommand
  }

  if (
    isEnvTruthy(process.env.USE_BUILTIN_RIPGREP) &&
    hasEmbeddedSearchTools()
  ) {
    const embedded = embeddedSearchToolsBinaryPath()
    if (embedded) {
      cachedRgCommand = { command: embedded, mode: 'embedded' }
      return cachedRgCommand
    }
  }

  const systemRg = whichSync('rg')
  if (systemRg) {
    cachedRgCommand = { command: systemRg, mode: 'system' }
    return cachedRgCommand
  }

  const embeddedFallback = embeddedSearchToolsBinaryPath()
  if (embeddedFallback) {
    cachedRgCommand = { command: embeddedFallback, mode: 'embedded' }
    return cachedRgCommand
  }

  cachedRgCommand = null
  return null
}

/**
 * Clears cached ripgrep binary detection (for tests).
 */
export function resetRipgrepDetectionForTesting(): void {
  cachedRgCommand = undefined
}

/**
 * Reports whether ripgrep is available via embedded binary, system PATH, or
 * pure-TS fallback.
 */
export function getRipgrepStatus(): {
  available: boolean
  mode: 'embedded' | 'system' | 'fallback'
  command?: string
} {
  const detected = ripgrepCommand()
  if (!detected) {
    return { available: false, mode: 'fallback' }
  }
  return {
    available: true,
    mode: detected.mode,
    command: detected.command,
  }
}

// ============================================================================
// Pure-TS Ripgrep Fallback Engine
// ============================================================================

const RG_TYPE_EXTENSIONS: Record<string, readonly string[]> = {
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py', '.pyi'],
  python: ['.py', '.pyi'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  json: ['.json', '.jsonc'],
  md: ['.md', '.mdx', '.markdown'],
  markdown: ['.md', '.mdx', '.markdown'],
  html: ['.html', '.htm'],
  css: ['.css', '.scss', '.less'],
  sh: ['.sh', '.bash', '.zsh'],
  yaml: ['.yml', '.yaml'],
  toml: ['.toml'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'],
  rb: ['.rb'],
  php: ['.php'],
  sql: ['.sql'],
  xml: ['.xml'],
  swift: ['.swift'],
  kt: ['.kt', '.kts'],
}

interface ParsedRgArgs {
  filesMode: boolean
  filesWithMatches: boolean
  countMode: boolean
  lineNumbers: boolean
  ignoreCase: boolean
  multiline: boolean
  hidden: boolean
  noIgnore: boolean
  sortByModified: boolean
  afterContext: number
  beforeContext: number
  maxColumns: number
  pattern?: string
  globs: string[]
  types: string[]
}

function parseRgArgs(args: readonly string[]): ParsedRgArgs {
  const parsed: ParsedRgArgs = {
    filesMode: false,
    filesWithMatches: false,
    countMode: false,
    lineNumbers: false,
    ignoreCase: false,
    multiline: false,
    hidden: false,
    noIgnore: false,
    sortByModified: false,
    afterContext: 0,
    beforeContext: 0,
    maxColumns: 0,
    globs: [],
    types: [],
  }

  let endOfFlags = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (endOfFlags) {
      if (parsed.pattern === undefined) {
        parsed.pattern = arg
      }
      continue
    }

    if (arg === '--files') {
      parsed.filesMode = true
    } else if (arg === '-l' || arg === '--files-with-matches') {
      parsed.filesWithMatches = true
    } else if (arg === '-c' || arg === '--count') {
      parsed.countMode = true
    } else if (arg === '-n' || arg === '--line-number') {
      parsed.lineNumbers = true
    } else if (arg === '--no-line-number') {
      parsed.lineNumbers = false
    } else if (arg === '-i' || arg === '--ignore-case') {
      parsed.ignoreCase = true
    } else if (arg === '-U' || arg === '--multiline' || arg === '--multiline-dotall') {
      parsed.multiline = true
    } else if (arg === '--hidden') {
      parsed.hidden = true
    } else if (arg === '--no-ignore' || arg === '--no-ignore-vcs') {
      parsed.noIgnore = true
    } else if (arg === '--sort=modified' || arg === '--sortr=modified') {
      parsed.sortByModified = true
    } else if (arg === '-e' || arg === '--regexp') {
      parsed.pattern = args[++i]
    } else if (arg === '-g' || arg === '--glob' || arg === '--iglob') {
      const next = args[++i]
      if (next !== undefined) parsed.globs.push(next)
    } else if (arg.startsWith('--glob=')) {
      parsed.globs.push(arg.slice('--glob='.length))
    } else if (arg === '--type' || arg === '-t') {
      const next = args[++i]
      if (next !== undefined) parsed.types.push(next.toLowerCase())
    } else if (arg.startsWith('--type=')) {
      parsed.types.push(arg.slice('--type='.length).toLowerCase())
    } else if (arg === '-A' || arg === '--after-context') {
      parsed.afterContext = Number.parseInt(args[++i] ?? '0', 10) || 0
    } else if (arg === '-B' || arg === '--before-context') {
      parsed.beforeContext = Number.parseInt(args[++i] ?? '0', 10) || 0
    } else if (arg === '-C' || arg === '--context') {
      const val = Number.parseInt(args[++i] ?? '0', 10) || 0
      parsed.beforeContext = val
      parsed.afterContext = val
    } else if (arg === '--max-columns') {
      parsed.maxColumns = Number.parseInt(args[++i] ?? '0', 10) || 0
    } else if (arg.startsWith('--max-columns=')) {
      parsed.maxColumns =
        Number.parseInt(arg.slice('--max-columns='.length), 10) || 0
    } else if (
      arg === '--color' ||
      arg === '--sort' ||
      arg === '--sortr' ||
      arg === '--max-depth'
    ) {
      const next = args[++i]
      if ((arg === '--sort' || arg === '--sortr') && next === 'modified') {
        parsed.sortByModified = true
      }
    } else if (!arg.startsWith('-') && parsed.pattern === undefined) {
      parsed.pattern = arg
    }
  }

  return parsed
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function compileGlobFilters(globs: readonly string[]): {
  includes: Array<(relPosix: string) => boolean>
  excludes: Array<(relPosix: string) => boolean>
} {
  const isWindows = getPlatform() === 'windows'
  const includes: Array<(relPosix: string) => boolean> = []
  const excludes: Array<(relPosix: string) => boolean> = []

  for (const raw of globs) {
    const isNegated = raw.startsWith('!')
    const pattern = (isNegated ? raw.slice(1) : raw).replace(/^\/+/, '')
    if (!pattern) continue

    const hasSlash = pattern.includes('/')
    const matcher = picomatch(pattern, {
      dot: true,
      nocase: isWindows,
      matchBase: !hasSlash,
    })

    const fn = (relPosix: string): boolean => {
      if (matcher(relPosix)) return true
      // Match trailing directory exclusions like `!node_modules/**` or `!.git/`
      if (pattern.endsWith('/')) {
        const prefix = pattern.slice(0, -1)
        return relPosix === prefix || relPosix.startsWith(`${prefix}/`)
      }
      return false
    }

    if (isNegated) {
      excludes.push(fn)
    } else {
      includes.push(fn)
    }
  }

  return { includes, excludes }
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buf = Buffer.alloc(BINARY_CHECK_BYTES)
    const { bytesRead } = await handle.read(buf, 0, BINARY_CHECK_BYTES, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) {
        return true
      }
    }
    return false
  } catch {
    return true
  } finally {
    await handle?.close()
  }
}

interface IgnoreEntry {
  dirPosix: string
  ig: ReturnType<typeof ignore>
}

async function loadGitignoreForDir(
  absDir: string,
  rootDir: string,
): Promise<IgnoreEntry | null> {
  try {
    const content = await readFile(join(absDir, '.gitignore'), 'utf8')
    const ig = ignore().add(content)
    const rel = toPosix(relative(rootDir, absDir))
    return { dirPosix: rel, ig }
  } catch {
    return null
  }
}

function isIgnoredByChain(
  relPosix: string,
  isDir: boolean,
  chain: readonly IgnoreEntry[],
): boolean {
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i]!
    const localRel =
      entry.dirPosix === ''
        ? relPosix
        : relPosix.startsWith(`${entry.dirPosix}/`)
          ? relPosix.slice(entry.dirPosix.length + 1)
          : null
    if (!localRel) continue
    const testPath = isDir ? `${localRel}/` : localRel
    if (entry.ig.ignores(testPath)) {
      return true
    }
  }
  return false
}

async function collectFilesFallback(
  targetPath: string,
  parsed: ParsedRgArgs,
  abortSignal: AbortSignal,
  deadlineMs: number,
): Promise<Array<{ fullPath: string; relPosix: string; mtimeMs: number }>> {
  const absTarget = resolve(targetPath)
  const targetStats = await stat(absTarget)
  const { includes, excludes } = compileGlobFilters(parsed.globs)

  const matchesType = (filePath: string): boolean => {
    if (parsed.types.length === 0) return true
    const ext = extname(filePath).toLowerCase()
    return parsed.types.some(t => {
      const exts = RG_TYPE_EXTENSIONS[t]
      return exts ? exts.includes(ext) : ext === `.${t}`
    })
  }

  const matchesGlobs = (relPosix: string): boolean => {
    if (excludes.some(fn => fn(relPosix))) return false
    if (includes.length > 0 && !includes.some(fn => fn(relPosix))) return false
    return true
  }

  if (targetStats.isFile()) {
    const base = toPosix(relative(resolve(absTarget, '..'), absTarget))
    if (matchesType(absTarget) && matchesGlobs(base)) {
      return [
        {
          fullPath: absTarget,
          relPosix: base,
          mtimeMs: targetStats.mtimeMs,
        },
      ]
    }
    return []
  }

  const results: Array<{ fullPath: string; relPosix: string; mtimeMs: number }> =
    []

  const walk = async (
    dir: string,
    ignoreChain: readonly IgnoreEntry[],
  ): Promise<void> => {
    if (abortSignal.aborted) {
      return
    }
    if (Date.now() > deadlineMs) {
      throw new RipgrepTimeoutError(DEFAULT_RG_TIMEOUT_MS)
    }

    let nextChain = ignoreChain
    if (!parsed.noIgnore) {
      const dirIgnore = await loadGitignoreForDir(dir, absTarget)
      if (dirIgnore) {
        nextChain = [...ignoreChain, dirIgnore]
      }
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (abortSignal.aborted) return
      const name = entry.name
      if (name === '.git') continue
      if (!parsed.hidden && name.startsWith('.')) {
        continue
      }

      const fullPath = join(dir, name)
      const relPosix = toPosix(relative(absTarget, fullPath))

      if (entry.isDirectory()) {
        if (
          !parsed.noIgnore &&
          isIgnoredByChain(relPosix, true, nextChain)
        ) {
          continue
        }
        if (excludes.some(fn => fn(relPosix) || fn(`${relPosix}/`))) {
          continue
        }
        await walk(fullPath, nextChain)
      } else if (entry.isFile()) {
        if (
          !parsed.noIgnore &&
          isIgnoredByChain(relPosix, false, nextChain)
        ) {
          continue
        }
        if (!matchesType(fullPath) || !matchesGlobs(relPosix)) {
          continue
        }
        let mtimeMs = 0
        if (parsed.sortByModified) {
          try {
            mtimeMs = (await stat(fullPath)).mtimeMs
          } catch {
            mtimeMs = 0
          }
        }
        results.push({ fullPath, relPosix, mtimeMs })
      }
    }
  }

  await walk(absTarget, [])

  if (parsed.sortByModified) {
    results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } else {
    results.sort((a, b) => a.relPosix.localeCompare(b.relPosix))
  }

  return results
}

function buildSearchRegex(pattern: string, parsed: ParsedRgArgs): RegExp {
  const flags =
    (parsed.ignoreCase ? 'i' : '') + (parsed.multiline ? 'gms' : 'g')
  return new RegExp(pattern, flags)
}

function truncateColumns(line: string, maxColumns: number): string {
  if (maxColumns > 0 && line.length > maxColumns) {
    return line.slice(0, maxColumns) + '…'
  }
  return line
}

async function runFallbackRipgrep(
  args: readonly string[],
  target: string,
  abortSignal: AbortSignal,
  config?: RipgrepConfig,
): Promise<string[]> {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_RG_TIMEOUT_MS
  const deadlineMs = Date.now() + timeoutMs
  const parsed = parseRgArgs(args)
  const absTarget = resolve(target)
  const targetIsFile = (await stat(absTarget)).isFile()

  const files = await collectFilesFallback(
    absTarget,
    parsed,
    abortSignal,
    deadlineMs,
  )

  if (parsed.filesMode) {
    const lines = files.map(f => f.fullPath)
    return config?.maxLines ? lines.slice(0, config.maxLines) : lines
  }

  if (!parsed.pattern) {
    return []
  }

  const regex = buildSearchRegex(parsed.pattern, parsed)
  const output: string[] = []
  const maxLines = config?.maxLines ?? Infinity

  for (const file of files) {
    if (abortSignal.aborted || output.length >= maxLines) break
    if (Date.now() > deadlineMs) {
      throw new RipgrepTimeoutError(timeoutMs)
    }

    let fileStats
    try {
      fileStats = await stat(file.fullPath)
    } catch {
      continue
    }
    if (fileStats.size > MAX_FALLBACK_FILE_BYTES) continue
    if (await isBinaryFile(file.fullPath)) continue

    let content: string
    try {
      content = await readFile(file.fullPath, 'utf8')
    } catch {
      continue
    }

    const displayPath = targetIsFile ? absTarget : file.fullPath

    if (parsed.multiline) {
      regex.lastIndex = 0
      const matches = Array.from(content.matchAll(regex))
      if (matches.length === 0) continue

      if (parsed.filesWithMatches) {
        output.push(displayPath)
        continue
      }
      if (parsed.countMode) {
        output.push(`${displayPath}:${matches.length}`)
        continue
      }

      const lines = content.split(/\r?\n/)
      const matchedLineIndices = new Set<number>()
      for (const m of matches) {
        const idx = m.index ?? 0
        const before = content.slice(0, idx)
        const startLineIdx = before.split(/\r?\n/).length - 1
        const matchLineCount = m[0].split(/\r?\n/).length
        for (let l = startLineIdx; l < startLineIdx + matchLineCount; l++) {
          if (l < lines.length) matchedLineIndices.add(l)
        }
      }
      const sortedLines = Array.from(matchedLineIndices).sort((a, b) => a - b)
      for (const lineIdx of sortedLines) {
        if (output.length >= maxLines) break
        const text = truncateColumns(lines[lineIdx]!, parsed.maxColumns)
        output.push(
          parsed.lineNumbers
            ? `${displayPath}:${lineIdx + 1}:${text}`
            : `${displayPath}:${text}`,
        )
      }
      continue
    }

    // Single-line matching
    const lines = content.split(/\r?\n/)
    const matchedIndices: number[] = []
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0
      if (regex.test(lines[i]!)) {
        matchedIndices.push(i)
      }
    }

    if (matchedIndices.length === 0) continue

    if (parsed.filesWithMatches) {
      output.push(displayPath)
      continue
    }
    if (parsed.countMode) {
      output.push(`${displayPath}:${matchedIndices.length}`)
      continue
    }

    const matchedSet = new Set(matchedIndices)
    const emitted = new Set<number>()
    const orderedEmit: number[] = []
    for (const idx of matchedIndices) {
      const start = Math.max(0, idx - parsed.beforeContext)
      const end = Math.min(lines.length - 1, idx + parsed.afterContext)
      for (let j = start; j <= end; j++) {
        if (!emitted.has(j)) {
          emitted.add(j)
          orderedEmit.push(j)
        }
      }
    }
    orderedEmit.sort((a, b) => a - b)

    for (let k = 0; k < orderedEmit.length; k++) {
      if (output.length >= maxLines) break
      const lineIdx = orderedEmit[k]!
      if (
        k > 0 &&
        lineIdx > orderedEmit[k - 1]! + 1 &&
        (parsed.beforeContext > 0 || parsed.afterContext > 0)
      ) {
        output.push('--')
      }
      const sep = matchedSet.has(lineIdx) ? ':' : '-'
      const text = truncateColumns(lines[lineIdx]!, parsed.maxColumns)
      output.push(
        parsed.lineNumbers
          ? `${displayPath}${sep}${lineIdx + 1}${sep}${text}`
          : `${displayPath}${sep}${text}`,
      )
    }
  }

  return output
}

// ============================================================================
// Public Ripgrep API
// ============================================================================

/**
 * Runs ripgrep (or pure-TS fallback when `rg` is unavailable) and returns
 * collected output lines.
 */
export async function ripGrep(
  args: readonly string[],
  target: string,
  abortSignal: AbortSignal,
  config?: RipgrepConfig,
): Promise<string[]> {
  const rg = config?.forceFallback ? null : ripgrepCommand()
  if (!rg) {
    return runFallbackRipgrep(args, target, abortSignal, config)
  }

  const timeoutMs = config?.timeoutMs ?? DEFAULT_RG_TIMEOUT_MS
  const maxLines = config?.maxLines ?? Infinity

  return new Promise<string[]>((resolvePromise, rejectPromise) => {
    const child = spawn(rg.command, [...args, target], {
      cwd: config?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const lines: string[] = []
    let buffer = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      abortSignal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    if (abortSignal.aborted) {
      onAbort()
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.length > 0) {
          lines.push(line)
          if (lines.length >= maxLines) {
            try {
              child.kill('SIGTERM')
            } catch {
              // ignore
            }
            return
          }
        }
        nl = buffer.indexOf('\n')
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', err => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(err)
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      cleanup()

      if (buffer.length > 0 && lines.length < maxLines) {
        const trailing = buffer.replace(/\r$/, '')
        if (trailing.length > 0) {
          lines.push(trailing)
        }
      }

      if (timedOut) {
        rejectPromise(new RipgrepTimeoutError(timeoutMs))
        return
      }
      // rg exit code 0 = matches found, 1 = no matches, 2 = error
      if (code === 0 || code === 1 || abortSignal.aborted || lines.length >= maxLines) {
        resolvePromise(lines)
        return
      }
      rejectPromise(
        new Error(stderr.trim() || `ripgrep exited with status code ${code}`),
      )
    })
  })
}

/**
 * Streams ripgrep output lines as an async generator.
 */
export async function* ripGrepStream(
  args: readonly string[],
  target: string,
  abortSignal: AbortSignal,
  config?: RipgrepConfig,
): AsyncGenerator<string, void> {
  const lines = await ripGrep(args, target, abortSignal, config)
  for (const line of lines) {
    yield line
  }
}

/**
 * Counts files under `target` rounded to an order-of-magnitude bucket for
 * non-PII analytics.
 */
export async function countFilesRoundedRg(
  target: string,
  abortSignal: AbortSignal,
): Promise<number> {
  const files = await ripGrep(['--files'], target, abortSignal, {
    maxLines: 10_000,
  })
  const count = files.length
  if (count <= 10) return count
  if (count <= 100) return Math.round(count / 10) * 10
  if (count <= 1000) return Math.round(count / 100) * 100
  return Math.round(count / 1000) * 1000
}
