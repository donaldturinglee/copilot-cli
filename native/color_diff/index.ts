/**
 * Pure-TS syntax-highlighted diff and file renderer.
 *
 * Uses lazy-loaded `highlight.js` (so cold startup does not pay 190-grammar
 * load cost), word-level inline diffs via `diffArrays`, RGB -> xterm-256
 * perceptual quantization, and Truecolor / 256-color / ANSI escape rendering.
 */

import { diffArrays } from 'diff'
import type { HLJSApi } from 'highlight.js'
import { createRequire } from 'module'
import { basename, extname } from 'path'

type ColorDiffLogger = (message: string) => void
type StringWidthFn = (text: string) => number

let customLogger: ColorDiffLogger | null = null
let customStringWidth: StringWidthFn | null = null

export function setColorDiffLogger(logger: ColorDiffLogger | null): void {
  customLogger = logger
}

export function setColorDiffStringWidth(fn: StringWidthFn | null): void {
  customStringWidth = fn
}

function logForDebugging(message: string): void {
  customLogger?.(message)
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  )
}

function stringWidth(text: string): number {
  if (customStringWidth) return customStringWidth(text)
  if (text.length === 0) return 0
  if (typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function') {
    return Bun.stringWidth(text)
  }
  const stripped = text.includes('\x1b') ? text.replace(ANSI_RE, '') : text
  let width = 0
  for (const ch of stripped) {
    const cp = ch.codePointAt(0)!
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue
    if (cp >= 0x0300 && cp <= 0x036f) continue
    if ((cp >= 0x200b && cp <= 0x200d) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue
    width += isWideCodePoint(cp) ? 2 : 1
  }
  return width
}

const localRequire = createRequire(import.meta.url)

// Lazy-load highlight.js on first highlight call to keep startup instant
let cachedHljs: HLJSApi | null = null
function hljs(): HLJSApi {
  if (!cachedHljs) {
    const loaded = localRequire('highlight.js') as HLJSApi | { default: HLJSApi }
    cachedHljs = 'default' in loaded && loaded.default ? loaded.default : (loaded as HLJSApi)
  }
  return cachedHljs
}

export function isHighlightJsLoaded(): boolean {
  return cachedHljs !== null
}

export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type SyntaxTheme = {
  theme: string
  source: string | null
}

export type NativeColorDiffModule = {
  ColorDiff: typeof ColorDiff
  ColorFile: typeof ColorFile
  getSyntaxTheme: typeof getSyntaxTheme
}

type Color =
  | { kind: 'rgb'; r: number; g: number; b: number }
  | { kind: 'ansi'; idx: number }
  | { kind: 'default' }

type Style = {
  foreground: Color
  background: Color
}

type Block = [Style, string]
type Marker = '+' | '-' | ' '
type ColorMode = 'truecolor' | 'ansi256' | 'ansi'

const DEFAULT_BG: Color = { kind: 'default' }
const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'
const RESET = '\x1b[0m'

function rgb(r: number, g: number, b: number): Color {
  return { kind: 'rgb', r, g, b }
}

function ansiIdx(idx: number): Color {
  return { kind: 'ansi', idx }
}

/**
 * Perceptually weighted RGB -> xterm-256 quantization across the 6x6x6
 * color cube (16..231) and 24-step grayscale ramp (232..255).
 */
export function ansi256FromRgb(r: number, g: number, b: number): number {
  const levels = [0, 95, 135, 175, 215, 255]
  const nearestCube = (c: number): number => {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < 6; i++) {
      const d = Math.abs(c - levels[i]!)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  const cr = nearestCube(r)
  const cg = nearestCube(g)
  const cb = nearestCube(b)
  const cubeIdx = 16 + 36 * cr + 6 * cg + cb

  const crVal = levels[cr]!
  const cgVal = levels[cg]!
  const cbVal = levels[cb]!
  const cubeDist =
    2 * (r - crVal) ** 2 + 4 * (g - cgVal) ** 2 + 3 * (b - cbVal) ** 2

  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  const grayStep = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)))
  const grayVal = 8 + grayStep * 10
  const grayDist =
    2 * (r - grayVal) ** 2 + 4 * (g - grayVal) ** 2 + 3 * (b - grayVal) ** 2

  return grayDist < cubeDist ? 232 + grayStep : cubeIdx
}

function colorToEscape(color: Color, isBg: boolean, mode: ColorMode): string {
  if (color.kind === 'default') return ''
  if (color.kind === 'ansi') {
    const idx = color.idx
    if (mode === 'ansi' || idx < 16) {
      if (idx < 8) return `\x1b[${(isBg ? 40 : 30) + idx}m`
      if (idx < 16) return `\x1b[${(isBg ? 100 : 90) + (idx - 8)}m`
    }
    return `\x1b[${isBg ? 48 : 38};5;${idx}m`
  }
  if (mode === 'truecolor') {
    return `\x1b[${isBg ? 48 : 38};2;${color.r};${color.g};${color.b}m`
  }
  const idx = ansi256FromRgb(color.r, color.g, color.b)
  return `\x1b[${isBg ? 48 : 38};5;${idx}m`
}

function colorsEqual(a: Color, b: Color): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'default') return true
  if (a.kind === 'ansi' && b.kind === 'ansi') return a.idx === b.idx
  if (a.kind === 'rgb' && b.kind === 'rgb') {
    return a.r === b.r && a.g === b.g && a.b === b.b
  }
  return false
}

function asTerminalEscaped(
  line: Block[],
  mode: ColorMode,
  skipBg: boolean,
  dim: boolean,
): string {
  let out = dim ? DIM : ''
  let prevFg: Color = { kind: 'default' }
  let prevBg: Color = { kind: 'default' }
  let styled = dim

  for (const [style, text] of line) {
    if (text.length === 0) continue
    if (!colorsEqual(style.foreground, prevFg)) {
      out +=
        style.foreground.kind === 'default'
          ? '\x1b[39m'
          : colorToEscape(style.foreground, false, mode)
      prevFg = style.foreground
      styled = true
    }
    if (!skipBg && !colorsEqual(style.background, prevBg)) {
      out +=
        style.background.kind === 'default'
          ? '\x1b[49m'
          : colorToEscape(style.background, true, mode)
      prevBg = style.background
      styled = true
    }
    out += text
  }

  if (styled) {
    out += RESET
  }
  return out
}

function detectColorMode(themeName: string): ColorMode {
  if (themeName.includes('ansi')) return 'ansi'
  const ct = (process.env.COLORTERM ?? '').toLowerCase()
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor'
  return 'ansi256'
}

function defaultSyntaxThemeName(themeName: string): string {
  if (themeName.includes('ansi')) return 'ansi'
  return themeName.includes('dark') ? 'Monokai Extended' : 'GitHub'
}

type DiffTheme = {
  addLine: Color
  addWord: Color
  addDecoration: Color
  deleteLine: Color
  deleteWord: Color
  deleteDecoration: Color
  foreground: Color
  background: Color
  scopes: Record<string, Color>
}

const MONOKAI_SCOPES: Record<string, Color> = {
  keyword: rgb(249, 38, 114),
  _storage: rgb(102, 217, 239),
  built_in: rgb(102, 217, 239),
  type: rgb(102, 217, 239),
  literal: rgb(174, 129, 255),
  number: rgb(174, 129, 255),
  string: rgb(230, 219, 116),
  title: rgb(166, 226, 46),
  'title.function': rgb(166, 226, 46),
  'title.class': rgb(166, 226, 46),
  'title.class.inherited': rgb(166, 226, 46),
  params: rgb(253, 151, 31),
  comment: rgb(117, 113, 94),
  meta: rgb(117, 113, 94),
  attr: rgb(166, 226, 46),
  attribute: rgb(166, 226, 46),
  variable: rgb(255, 255, 255),
  'variable.language': rgb(255, 255, 255),
  property: rgb(255, 255, 255),
  operator: rgb(249, 38, 114),
  punctuation: rgb(248, 248, 242),
  symbol: rgb(190, 132, 255),
  regexp: rgb(230, 219, 116),
  subst: rgb(248, 248, 242),
}

const GITHUB_SCOPES: Record<string, Color> = {
  keyword: rgb(167, 29, 93),
  _storage: rgb(167, 29, 93),
  built_in: rgb(0, 134, 179),
  type: rgb(0, 134, 179),
  literal: rgb(0, 134, 179),
  number: rgb(0, 134, 179),
  string: rgb(24, 54, 145),
  title: rgb(121, 93, 163),
  'title.function': rgb(121, 93, 163),
  'title.class': rgb(0, 0, 0),
  'title.class.inherited': rgb(0, 0, 0),
  params: rgb(0, 134, 179),
  comment: rgb(150, 152, 150),
  meta: rgb(150, 152, 150),
  attr: rgb(0, 134, 179),
  attribute: rgb(0, 134, 179),
  variable: rgb(0, 134, 179),
  'variable.language': rgb(0, 134, 179),
  property: rgb(0, 134, 179),
  operator: rgb(167, 29, 93),
  punctuation: rgb(51, 51, 51),
  symbol: rgb(0, 134, 179),
  regexp: rgb(24, 54, 145),
  subst: rgb(51, 51, 51),
}

const STORAGE_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'namespace',
  'module',
  'def',
  'fn',
  'func',
  'struct',
  'trait',
  'impl',
])

const ANSI_SCOPES: Record<string, Color> = {
  keyword: ansiIdx(13),
  _storage: ansiIdx(14),
  built_in: ansiIdx(14),
  type: ansiIdx(14),
  literal: ansiIdx(12),
  number: ansiIdx(12),
  string: ansiIdx(10),
  title: ansiIdx(11),
  'title.function': ansiIdx(11),
  'title.class': ansiIdx(11),
  comment: ansiIdx(8),
  meta: ansiIdx(8),
}

function buildTheme(themeName: string, mode: ColorMode): DiffTheme {
  const isDark = themeName.includes('dark')
  const isAnsi = themeName.includes('ansi')
  const isDaltonized = themeName.includes('daltonized')
  const tc = mode === 'truecolor'

  if (isAnsi) {
    return {
      addLine: DEFAULT_BG,
      addWord: DEFAULT_BG,
      addDecoration: ansiIdx(10),
      deleteLine: DEFAULT_BG,
      deleteWord: DEFAULT_BG,
      deleteDecoration: ansiIdx(9),
      foreground: ansiIdx(7),
      background: DEFAULT_BG,
      scopes: ANSI_SCOPES,
    }
  }

  if (isDark) {
    const fg = rgb(248, 248, 242)
    const deleteLine = rgb(61, 1, 0)
    const deleteWord = rgb(92, 2, 0)
    const deleteDecoration = rgb(220, 90, 90)
    if (isDaltonized) {
      return {
        addLine: tc ? rgb(0, 27, 41) : ansiIdx(17),
        addWord: tc ? rgb(0, 48, 71) : ansiIdx(24),
        addDecoration: rgb(81, 160, 200),
        deleteLine,
        deleteWord,
        deleteDecoration,
        foreground: fg,
        background: DEFAULT_BG,
        scopes: MONOKAI_SCOPES,
      }
    }
    return {
      addLine: tc ? rgb(2, 40, 0) : ansiIdx(22),
      addWord: tc ? rgb(4, 71, 0) : ansiIdx(28),
      addDecoration: rgb(80, 200, 80),
      deleteLine,
      deleteWord,
      deleteDecoration,
      foreground: fg,
      background: DEFAULT_BG,
      scopes: MONOKAI_SCOPES,
    }
  }

  const fg = rgb(51, 51, 51)
  const deleteLine = rgb(255, 220, 220)
  const deleteWord = rgb(255, 199, 199)
  const deleteDecoration = rgb(207, 34, 46)
  if (isDaltonized) {
    return {
      addLine: rgb(219, 237, 255),
      addWord: rgb(179, 217, 255),
      addDecoration: rgb(36, 87, 138),
      deleteLine,
      deleteWord,
      deleteDecoration,
      foreground: fg,
      background: DEFAULT_BG,
      scopes: GITHUB_SCOPES,
    }
  }
  return {
    addLine: rgb(220, 255, 220),
    addWord: rgb(178, 255, 178),
    addDecoration: rgb(36, 138, 61),
    deleteLine,
    deleteWord,
    deleteDecoration,
    foreground: fg,
    background: DEFAULT_BG,
    scopes: GITHUB_SCOPES,
  }
}

function defaultStyle(theme: DiffTheme): Style {
  return { foreground: theme.foreground, background: theme.background }
}

function lineBackground(marker: Marker, theme: DiffTheme): Color {
  switch (marker) {
    case '+':
      return theme.addLine
    case '-':
      return theme.deleteLine
    case ' ':
      return theme.background
  }
}

function wordBackground(marker: Marker, theme: DiffTheme): Color {
  switch (marker) {
    case '+':
      return theme.addWord
    case '-':
      return theme.deleteWord
    case ' ':
      return theme.background
  }
}

function decorationColor(marker: Marker, theme: DiffTheme): Color {
  switch (marker) {
    case '+':
      return theme.addDecoration
    case '-':
      return theme.deleteDecoration
    case ' ':
      return theme.foreground
  }
}

type HljsNode = {
  scope?: string
  kind?: string
  children: (HljsNode | string)[]
}

const FILENAME_LANGS: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  Rakefile: 'ruby',
  Gemfile: 'ruby',
  CMakeLists: 'cmake',
}

function detectLanguage(
  filePath: string,
  firstLine: string | null,
): string | null {
  const base = basename(filePath)
  const ext = extname(filePath).slice(1)
  const stem = base.split('.')[0] ?? ''
  const byName = FILENAME_LANGS[base] ?? FILENAME_LANGS[stem]
  if (byName && hljs().getLanguage(byName)) return byName
  if (ext && hljs().getLanguage(ext)) return ext

  if (firstLine) {
    const line = firstLine.startsWith('\ufeff') ? firstLine.slice(1) : firstLine
    if (line.startsWith('#!')) {
      if (line.includes('bash') || line.includes('/sh')) return 'bash'
      if (line.includes('python')) return 'python'
      if (line.includes('node')) return 'javascript'
      if (line.includes('ruby')) return 'ruby'
      if (line.includes('perl')) return 'perl'
    }
    if (line.startsWith('<?php')) return 'php'
    if (line.startsWith('<?xml')) return 'xml'
  }
  return null
}

function scopeColor(
  scope: string | undefined,
  text: string,
  theme: DiffTheme,
): Color {
  if (!scope) return theme.foreground
  if (scope === 'keyword' && STORAGE_KEYWORDS.has(text.trim())) {
    return theme.scopes['_storage'] ?? theme.foreground
  }
  return (
    theme.scopes[scope] ??
    theme.scopes[scope.split('.')[0]!] ??
    theme.foreground
  )
}

function flattenHljs(
  node: HljsNode | string,
  theme: DiffTheme,
  parentScope: string | undefined,
  out: Block[],
): void {
  if (typeof node === 'string') {
    const fg = scopeColor(parentScope, node, theme)
    out.push([{ foreground: fg, background: theme.background }, node])
    return
  }
  const scope = node.scope ?? node.kind ?? parentScope
  for (const child of node.children) {
    flattenHljs(child, theme, scope, out)
  }
}

function hasRootNode(emitter: unknown): emitter is { rootNode: HljsNode } {
  return (
    typeof emitter === 'object' &&
    emitter !== null &&
    'rootNode' in emitter &&
    typeof (emitter as { rootNode: unknown }).rootNode === 'object' &&
    (emitter as { rootNode: unknown }).rootNode !== null &&
    'children' in ((emitter as { rootNode: object }).rootNode)
  )
}

let loggedEmitterShapeError = false

function highlightLine(
  state: { lang: string | null },
  line: string,
  theme: DiffTheme,
): Block[] {
  const code = line + '\n'
  if (!state.lang) {
    return [[defaultStyle(theme), code]]
  }
  let result: ReturnType<HLJSApi['highlight']>
  try {
    result = hljs().highlight(code, {
      language: state.lang,
      ignoreIllegals: true,
    })
  } catch {
    return [[defaultStyle(theme), code]]
  }
  const emitter = (result as unknown as { emitter?: unknown; _emitter?: unknown })
    .emitter ?? (result as unknown as { _emitter?: unknown })._emitter
  if (!hasRootNode(emitter)) {
    if (!loggedEmitterShapeError) {
      loggedEmitterShapeError = true
      logForDebugging('color-diff: hljs emitter shape mismatch; falling back to plain text')
    }
    return [[defaultStyle(theme), code]]
  }
  const blocks: Block[] = []
  flattenHljs(emitter.rootNode, theme, undefined, blocks)
  return blocks
}

type Range = { start: number; end: number }

const CHANGE_THRESHOLD = 0.4

function tokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/[\p{L}\p{N}_]/u.test(ch)) {
      let j = i + 1
      while (j < text.length && /[\p{L}\p{N}_]/u.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else if (/\s/.test(ch)) {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      tokens.push(text.slice(i, j))
      i = j
    } else {
      const cp = text.codePointAt(i)!
      const len = cp > 0xffff ? 2 : 1
      tokens.push(text.slice(i, i + len))
      i += len
    }
  }
  return tokens
}

function findAdjacentPairs(markers: Marker[]): [number, number][] {
  const pairs: [number, number][] = []
  let i = 0
  while (i < markers.length) {
    if (markers[i] === '-') {
      const delStart = i
      let delEnd = i
      while (delEnd < markers.length && markers[delEnd] === '-') delEnd++
      let addEnd = delEnd
      while (addEnd < markers.length && markers[addEnd] === '+') addEnd++
      const delCount = delEnd - delStart
      const addCount = addEnd - delEnd
      if (delCount > 0 && addCount > 0) {
        const n = Math.min(delCount, addCount)
        for (let k = 0; k < n; k++) {
          pairs.push([delStart + k, delEnd + k])
        }
        i = addEnd
      } else {
        i = delEnd
      }
    } else {
      i++
    }
  }
  return pairs
}

function wordDiffStrings(oldStr: string, newStr: string): [Range[], Range[]] {
  const oldTokens = tokenize(oldStr)
  const newTokens = tokenize(newStr)
  const ops = diffArrays(oldTokens, newTokens)

  const totalLen = oldStr.length + newStr.length
  let changedLen = 0
  const oldRanges: Range[] = []
  const newRanges: Range[] = []
  let oldOff = 0
  let newOff = 0

  for (const op of ops) {
    const len = op.value.reduce((s, t) => s + t.length, 0)
    if (op.removed) {
      changedLen += len
      oldRanges.push({ start: oldOff, end: oldOff + len })
      oldOff += len
    } else if (op.added) {
      changedLen += len
      newRanges.push({ start: newOff, end: newOff + len })
      newOff += len
    } else {
      oldOff += len
      newOff += len
    }
  }

  if (totalLen > 0 && changedLen / totalLen > CHANGE_THRESHOLD) {
    return [[], []]
  }
  return [oldRanges, newRanges]
}

type Highlight = {
  marker: Marker | null
  lineNumber: number
  lines: Block[][]
}

function removeNewlines(h: Highlight): void {
  h.lines = h.lines.map(line =>
    line.flatMap(([style, text]) =>
      text
        .split('\n')
        .filter(p => p.length > 0)
        .map((p): Block => [style, p]),
    ),
  )
}

function wrapText(h: Highlight, width: number, theme: DiffTheme): void {
  const newLines: Block[][] = []
  for (const line of h.lines) {
    const queue: Block[] = line.slice()
    let cur: Block[] = []
    let curW = 0
    while (queue.length > 0) {
      const [style, text] = queue.shift()!
      const tw = stringWidth(text)
      if (curW + tw <= width) {
        cur.push([style, text])
        curW += tw
      } else {
        const remaining = width - curW
        let bytePos = 0
        let accW = 0
        for (const ch of text) {
          const cw = stringWidth(ch)
          if (accW + cw > remaining) break
          accW += cw
          bytePos += ch.length
        }
        if (bytePos === 0) {
          if (curW === 0) {
            const firstCp = text.codePointAt(0)!
            bytePos = firstCp > 0xffff ? 2 : 1
          } else {
            newLines.push(cur)
            queue.unshift([style, text])
            cur = []
            curW = 0
            continue
          }
        }
        cur.push([style, text.slice(0, bytePos)])
        newLines.push(cur)
        queue.unshift([style, text.slice(bytePos)])
        cur = []
        curW = 0
      }
    }
    newLines.push(cur)
  }
  h.lines = newLines

  if (h.marker && h.marker !== ' ') {
    const bg = lineBackground(h.marker, theme)
    const padStyle: Style = { foreground: theme.foreground, background: bg }
    for (const line of h.lines) {
      const curW = line.reduce((s, [, t]) => s + stringWidth(t), 0)
      if (curW < width) {
        line.push([padStyle, ' '.repeat(width - curW)])
      }
    }
  }
}

function addLineNumber(
  h: Highlight,
  theme: DiffTheme,
  maxDigits: number,
  fullDim: boolean,
): void {
  const style: Style = {
    foreground: h.marker ? decorationColor(h.marker, theme) : theme.foreground,
    background: h.marker ? lineBackground(h.marker, theme) : theme.background,
  }
  const shouldDim = h.marker === null || h.marker === ' '
  for (let i = 0; i < h.lines.length; i++) {
    const prefix =
      i === 0
        ? ` ${String(h.lineNumber).padStart(maxDigits)} `
        : ' '.repeat(maxDigits + 2)
    const wrapped = shouldDim && !fullDim ? `${DIM}${prefix}${UNDIM}` : prefix
    h.lines[i]!.unshift([style, wrapped])
  }
}

function addMarker(h: Highlight, theme: DiffTheme): void {
  if (!h.marker) return
  const style: Style = {
    foreground: decorationColor(h.marker, theme),
    background: lineBackground(h.marker, theme),
  }
  for (const line of h.lines) {
    line.unshift([style, h.marker])
  }
}

function dimContent(h: Highlight): void {
  for (const line of h.lines) {
    if (line.length > 0) {
      line[0]![1] = DIM + line[0]![1]
      const last = line.length - 1
      line[last]![1] = line[last]![1] + UNDIM
    }
  }
}

function applyBackground(h: Highlight, theme: DiffTheme, ranges: Range[]): void {
  if (!h.marker) return
  const lineBg = lineBackground(h.marker, theme)
  const wordBg = wordBackground(h.marker, theme)

  let rangeIdx = 0
  let byteOff = 0
  for (let li = 0; li < h.lines.length; li++) {
    const newLine: Block[] = []
    for (const [style, text] of h.lines[li]!) {
      const textStart = byteOff
      const textEnd = byteOff + text.length

      while (rangeIdx < ranges.length && ranges[rangeIdx]!.end <= textStart) {
        rangeIdx++
      }
      if (rangeIdx >= ranges.length) {
        newLine.push([{ ...style, background: lineBg }, text])
        byteOff = textEnd
        continue
      }

      let remaining = text
      let pos = textStart
      while (remaining.length > 0 && rangeIdx < ranges.length) {
        const r = ranges[rangeIdx]!
        const inRange = pos >= r.start && pos < r.end
        let next: number
        if (inRange) {
          next = Math.min(r.end, textEnd)
        } else if (r.start > pos && r.start < textEnd) {
          next = r.start
        } else {
          next = textEnd
        }
        const segLen = next - pos
        const seg = remaining.slice(0, segLen)
        newLine.push([{ ...style, background: inRange ? wordBg : lineBg }, seg])
        remaining = remaining.slice(segLen)
        pos = next
        if (pos >= r.end) rangeIdx++
      }
      if (remaining.length > 0) {
        newLine.push([{ ...style, background: lineBg }, remaining])
      }
      byteOff = textEnd
    }
    h.lines[li] = newLine
  }
}

function intoLines(
  h: Highlight,
  dim: boolean,
  skipBg: boolean,
  mode: ColorMode,
): string[] {
  return h.lines.map(line => asTerminalEscaped(line, mode, skipBg, dim))
}

function maxLineNumber(hunk: Hunk): number {
  const oldEnd = Math.max(0, hunk.oldStart + hunk.oldLines - 1)
  const newEnd = Math.max(0, hunk.newStart + hunk.newLines - 1)
  return Math.max(oldEnd, newEnd)
}

function parseMarker(s: string): Marker {
  return s === '+' || s === '-' ? s : ' '
}

export class ColorDiff {
  private hunk: Hunk
  private filePath: string
  private firstLine: string | null
  private prefixContent: string | null

  constructor(
    hunk: Hunk,
    firstLine: string | null,
    filePath: string,
    prefixContent?: string | null,
  ) {
    this.hunk = hunk
    this.filePath = filePath
    this.firstLine = firstLine
    this.prefixContent = prefixContent ?? null
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    const mode = detectColorMode(themeName)
    const theme = buildTheme(themeName, mode)
    const lang = detectLanguage(this.filePath, this.firstLine)
    const hlState = { lang }
    void this.prefixContent

    const maxDigits = Math.max(1, String(maxLineNumber(this.hunk)).length)
    let oldLine = this.hunk.oldStart
    let newLine = this.hunk.newStart
    const effectiveWidth = Math.max(1, width - maxDigits - 3)

    type Entry = { lineNumber: number; marker: Marker; code: string }
    const entries: Entry[] = this.hunk.lines.map(rawLine => {
      const marker = parseMarker(rawLine.slice(0, 1))
      const code = rawLine.slice(1)
      let lineNumber: number
      switch (marker) {
        case '+':
          lineNumber = newLine++
          break
        case '-':
          lineNumber = oldLine++
          break
        case ' ':
          lineNumber = newLine
          oldLine++
          newLine++
          break
      }
      return { lineNumber, marker, code }
    })

    const ranges: Range[][] = entries.map(() => [])
    if (!dim) {
      const markers = entries.map(e => e.marker)
      for (const [delIdx, addIdx] of findAdjacentPairs(markers)) {
        const [delR, addR] = wordDiffStrings(
          entries[delIdx]!.code,
          entries[addIdx]!.code,
        )
        ranges[delIdx] = delR
        ranges[addIdx] = addR
      }
    }

    const out: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const { lineNumber, marker, code } = entries[i]!
      const tokens: Block[] =
        marker === '-'
          ? [[defaultStyle(theme), code]]
          : highlightLine(hlState, code, theme)

      const h: Highlight = { marker, lineNumber, lines: [tokens] }
      removeNewlines(h)
      applyBackground(h, theme, ranges[i]!)
      wrapText(h, effectiveWidth, theme)
      if (mode === 'ansi' && marker === '-') {
        dimContent(h)
      }
      addMarker(h, theme)
      addLineNumber(h, theme, maxDigits, dim)
      out.push(...intoLines(h, dim, false, mode))
    }
    return out
  }
}

export class ColorFile {
  private code: string
  private filePath: string

  constructor(code: string, filePath: string) {
    this.code = code
    this.filePath = filePath
  }

  render(themeName: string, width: number, dim: boolean): string[] | null {
    const mode = detectColorMode(themeName)
    const theme = buildTheme(themeName, mode)
    const lines = this.code.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const firstLine = lines[0] ?? null
    const lang = detectLanguage(this.filePath, firstLine)
    const hlState = { lang }

    const maxDigits = Math.max(1, String(lines.length).length)
    const effectiveWidth = Math.max(1, width - maxDigits - 2)

    const out: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const tokens = highlightLine(hlState, lines[i]!, theme)
      const h: Highlight = { marker: null, lineNumber: i + 1, lines: [tokens] }
      removeNewlines(h)
      wrapText(h, effectiveWidth, theme)
      addLineNumber(h, theme, maxDigits, dim)
      out.push(...intoLines(h, dim, true, mode))
    }
    return out
  }
}

export function getSyntaxTheme(themeName: string): SyntaxTheme {
  const envTheme =
    process.env.COPILOT_CLI_SYNTAX_HIGHLIGHT ?? process.env.BAT_THEME
  void envTheme
  return { theme: defaultSyntaxThemeName(themeName), source: null }
}

let cachedModule: NativeColorDiffModule | null = null

export function getNativeModule(): NativeColorDiffModule {
  if (!cachedModule) {
    cachedModule = { ColorDiff, ColorFile, getSyntaxTheme }
  }
  return cachedModule
}

export const colorDiffInternals = {
  tokenize,
  findAdjacentPairs,
  wordDiffStrings,
  ansi256FromRgb,
  colorToEscape,
  detectColorMode,
  detectLanguage,
}
