import React, { useMemo } from 'react'
import { Box } from '../ink/components/box.js'
import { Text } from '../ink/components/text.js'
import { computeHorizontalWindow } from '../utilities/horizontal_scroll.js'
import type { ThemeColorKey } from './design_system/color.js'
import { ThemedText } from './design_system/themed_text.js'

export type InlineHighlight = {
  start: number
  end: number
  color: ThemeColorKey
  bold?: boolean
}

const TOKEN_HIGHLIGHT_RE =
  /(\[Image #\d+\]|\[Pasted text #\d+(?: \+\d+ lines)?\]|(?:^|\s)@[A-Za-z0-9_./-]+|^\/[A-Za-z0-9_-]+)/g

export function computeInlineHighlights(text: string): InlineHighlight[] {
  const highlights: InlineHighlight[] = []
  for (const m of text.matchAll(TOKEN_HIGHLIGHT_RE)) {
    const raw = m[0]
    let start = m.index ?? 0
    let token = raw
    if (token.startsWith(' ') || token.startsWith('\t')) {
      start += 1
      token = token.slice(1)
    }
    const end = start + token.length
    if (token.startsWith('[Image #') || token.startsWith('[Pasted text #')) {
      highlights.push({ start, end, color: 'permission', bold: true })
    } else if (token.startsWith('@')) {
      highlights.push({ start, end, color: 'suggestion' })
    } else if (token.startsWith('/')) {
      highlights.push({ start, end, color: 'claude', bold: true })
    }
  }
  return highlights
}

export type BaseTextInputProps = {
  value: string
  cursor: number
  placeholder?: string
  showCursor?: boolean
  mask?: string
  multiline?: boolean
  viewportWidth?: number
  highlights?: readonly InlineHighlight[]
}

/**
 * Pure presentation layer for single/multiline terminal text input with
 * multi-color inline token highlights and cursor rendering.
 */
export function BaseTextInput({
  value,
  cursor,
  placeholder = '',
  showCursor = true,
  mask,
  multiline = true,
  viewportWidth = 80,
  highlights,
}: BaseTextInputProps): React.ReactNode {
  const displayRaw = mask ? mask.repeat(value.length) : value

  const resolvedHighlights = useMemo(
    () => (mask ? [] : highlights ?? computeInlineHighlights(displayRaw)),
    [displayRaw, highlights, mask],
  )

  if (displayRaw.length === 0) {
    return (
      <Box flexDirection="row">
        {showCursor ? (
          <Text inverse>{placeholder[0] ?? ' '}</Text>
        ) : null}
        <ThemedText dimColor>
          {showCursor ? placeholder.slice(1) : placeholder}
        </ThemedText>
      </Box>
    )
  }

  if (!multiline && displayRaw.length > viewportWidth - 2) {
    const win = computeHorizontalWindow(displayRaw, cursor, viewportWidth - 2)
    return (
      <Box flexDirection="row">
        {win.hasLeftOverflow ? <ThemedText dimColor>‹</ThemedText> : null}
        <Text>
          {win.visibleText.slice(0, win.cursorInWindow)}
          {showCursor ? (
            <Text inverse>{win.visibleText[win.cursorInWindow] ?? ' '}</Text>
          ) : (
            win.visibleText[win.cursorInWindow] ?? ''
          )}
          {win.visibleText.slice(win.cursorInWindow + 1)}
        </Text>
        {win.hasRightOverflow ? <ThemedText dimColor>›</ThemedText> : null}
      </Box>
    )
  }

  // Render character segments honoring both highlights and cursor position
  const clampedCursor = Math.max(0, Math.min(cursor, displayRaw.length))
  const colorAt = (idx: number): { color?: ThemeColorKey; bold?: boolean } => {
    for (const h of resolvedHighlights) {
      if (idx >= h.start && idx < h.end) {
        return { color: h.color, bold: h.bold }
      }
    }
    return {}
  }

  const segments: React.ReactNode[] = []
  let i = 0
  while (i < displayRaw.length) {
    if (showCursor && i === clampedCursor) {
      const style = colorAt(i)
      segments.push(
        <ThemedText key={`cur-${i}`} color={style.color} bold={style.bold} inverse>
          {displayRaw[i] === '\n' ? ' \n' : displayRaw[i]!}
        </ThemedText>,
      )
      i++
      continue
    }

    const style = colorAt(i)
    let j = i + 1
    while (j < displayRaw.length) {
      if (showCursor && j === clampedCursor) break
      const nextStyle = colorAt(j)
      if (nextStyle.color !== style.color || nextStyle.bold !== style.bold) {
        break
      }
      j++
    }
    segments.push(
      <ThemedText key={`seg-${i}`} color={style.color} bold={style.bold}>
        {displayRaw.slice(i, j)}
      </ThemedText>,
    )
    i = j
  }

  if (showCursor && clampedCursor === displayRaw.length) {
    segments.push(
      <Text key="cur-end" inverse>
        {' '}
      </Text>,
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text>{segments}</Text>
    </Box>
  )
}
