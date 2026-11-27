import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from './string_width.js'

export type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

export type WrappedLine = {
  text: string
  softWrapped: boolean
}

function activeStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return reduceAnsiCodes(codes).filter(c => c.code !== c.endCode)
}

/**
 * Wrap an ANSI-styled string to `columns` display cells, closing and reopening
 * active SGR / OSC 8 styles cleanly across wrapped line boundaries and tracking
 * whether each line is a soft-wrap continuation.
 */
export function wrapAnsiLines(
  input: string,
  columns: number,
  options: WrapAnsiOptions = {},
): WrappedLine[] {
  const maxCols = Math.max(1, Math.floor(columns))
  const hard = options.hard ?? false
  const wordWrap = options.wordWrap ?? true
  const trim = options.trim ?? true

  const rawLines = input.split('\n')
  const result: WrappedLine[] = []

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      result.push({ text: '', softWrapped: false })
      continue
    }

    const tokens = tokenize(rawLine)
    let active: AnsiCode[] = []
    let currentLine = ''
    let currentWidth = 0
    let isContinuation = false

    const flushLine = (nextIsContinuation: boolean): void => {
      const open = activeStartCodes(active)
      const closeStr = ansiCodesToString(undoAnsiCodes(open))
      const lineOut = trim ? currentLine.trimEnd() : currentLine
      result.push({
        text: lineOut + closeStr,
        softWrapped: isContinuation,
      })
      active = open
      currentLine = ansiCodesToString(open)
      currentWidth = 0
      isContinuation = nextIsContinuation
    }

    // Group tokens into word units when wordWrap is enabled
    type Unit = {
      tokens: typeof tokens
      width: number
      isSpace: boolean
    }

    const units: Unit[] = []
    if (wordWrap) {
      let curTokens: typeof tokens = []
      let curW = 0
      let curIsSpace: boolean | null = null

      for (const tok of tokens) {
        if (tok.type === 'ansi') {
          curTokens.push(tok)
          continue
        }
        if (tok.type !== 'char') continue
        const isSp = tok.value === ' '
        const w = tok.fullWidth ? 2 : stringWidth(tok.value)
        if (curIsSpace !== null && curIsSpace !== isSp) {
          units.push({ tokens: curTokens, width: curW, isSpace: curIsSpace })
          curTokens = [tok]
          curW = w
          curIsSpace = isSp
        } else {
          curTokens.push(tok)
          curW += w
          curIsSpace = isSp
        }
      }
      if (curTokens.length > 0) {
        units.push({
          tokens: curTokens,
          width: curW,
          isSpace: curIsSpace ?? false,
        })
      }
    } else {
      for (const tok of tokens) {
        if (tok.type === 'control') continue
        const w =
          tok.type === 'ansi' ? 0 : tok.fullWidth ? 2 : stringWidth(tok.value)
        units.push({
          tokens: [tok],
          width: w,
          isSpace: tok.type === 'char' && tok.value === ' ',
        })
      }
    }

    for (const unit of units) {
      if (unit.isSpace && currentWidth === 0 && isContinuation && trim) {
        for (const tok of unit.tokens) {
          if (tok.type === 'ansi') {
            active.push(tok)
            currentLine += tok.code
          }
        }
        continue
      }

      if (currentWidth + unit.width <= maxCols) {
        for (const tok of unit.tokens) {
          if (tok.type === 'ansi') {
            active.push(tok)
            currentLine += tok.code
          } else if (tok.type === 'char') {
            currentLine += tok.value
          }
        }
        currentWidth += unit.width
        continue
      }

      // Doesn't fit on current line
      if (currentWidth > 0 && unit.width <= maxCols) {
        flushLine(true)
        if (unit.isSpace && trim) {
          for (const tok of unit.tokens) {
            if (tok.type === 'ansi') {
              active.push(tok)
              currentLine += tok.code
            }
          }
          continue
        }
        for (const tok of unit.tokens) {
          if (tok.type === 'ansi') {
            active.push(tok)
            currentLine += tok.code
          } else if (tok.type === 'char') {
            currentLine += tok.value
          }
        }
        currentWidth += unit.width
        continue
      }

      // Unit is wider than maxCols — break inside unit if hard wrap or single-char mode
      if (!hard && wordWrap && currentWidth > 0) {
        flushLine(true)
      }

      for (const tok of unit.tokens) {
        if (tok.type === 'ansi') {
          active.push(tok)
          currentLine += tok.code
          continue
        }
        if (tok.type !== 'char') continue
        const w = tok.fullWidth ? 2 : stringWidth(tok.value)
        if (currentWidth + w > maxCols && currentWidth > 0) {
          flushLine(true)
        }
        currentLine += tok.value
        currentWidth += w
      }
    }

    const open = activeStartCodes(active)
    const closeStr = ansiCodesToString(undoAnsiCodes(open))
    result.push({
      text: (trim ? currentLine.trimEnd() : currentLine) + closeStr,
      softWrapped: isContinuation,
    })
  }

  return result
}

export function wrapAnsi(
  input: string,
  columns: number,
  options: WrapAnsiOptions = {},
): string {
  return wrapAnsiLines(input, columns, options)
    .map(l => l.text)
    .join('\n')
}
