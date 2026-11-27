import React from 'react'
import { Box } from '../ink/components/box.js'
import { stringWidth } from '../ink/string_width.js'
import { truncateToWidth } from '../utilities/truncate.js'
import { ThemedText } from './design_system/themed_text.js'

export type TableAlign = 'left' | 'center' | 'right' | null

export type MarkdownTableProps = {
  headers: string[]
  rows: string[][]
  align?: TableAlign[]
  maxWidth?: number
}

function padCell(text: string, width: number, align: TableAlign): string {
  const clipped = truncateToWidth(text, width)
  const w = stringWidth(clipped)
  const diff = Math.max(0, width - w)
  if (align === 'right') return ' '.repeat(diff) + clipped
  if (align === 'center') {
    const left = Math.floor(diff / 2)
    return ' '.repeat(left) + clipped + ' '.repeat(diff - left)
  }
  return clipped + ' '.repeat(diff)
}

export function MarkdownTable({
  headers,
  rows,
  align = [],
  maxWidth = 80,
}: MarkdownTableProps): React.ReactNode {
  const colCount = Math.max(
    headers.length,
    ...rows.map(r => r.length),
  )
  if (colCount === 0) return null

  const colWidths: number[] = new Array(colCount).fill(1)
  for (let c = 0; c < colCount; c++) {
    colWidths[c] = Math.max(colWidths[c]!, stringWidth(headers[c] ?? ''))
    for (const row of rows) {
      colWidths[c] = Math.max(colWidths[c]!, stringWidth(row[c] ?? ''))
    }
  }

  // Fit within maxWidth (accounting for borders & 2 spaces padding per column)
  const overhead = colCount * 3 + 1
  const budget = Math.max(colCount * 3, maxWidth - overhead)
  const sum = colWidths.reduce((a, b) => a + b, 0)
  if (sum > budget) {
    const scale = budget / sum
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(3, Math.floor(colWidths[c]! * scale))
    }
  }

  const makeRule = (left: string, mid: string, right: string): string =>
    left + colWidths.map(w => '─'.repeat(w + 2)).join(mid) + right

  const renderRow = (cells: string[]): string =>
    '│' +
    colWidths
      .map(
        (w, c) =>
          ' ' + padCell(cells[c] ?? '', w, align[c] ?? 'left') + ' ',
      )
      .join('│') +
    '│'

  return (
    <Box flexDirection="column">
      <ThemedText color="subtle">{makeRule('┌', '┬', '┐')}</ThemedText>
      <ThemedText bold>{renderRow(headers)}</ThemedText>
      <ThemedText color="subtle">{makeRule('├', '┼', '┤')}</ThemedText>
      {rows.map((row, idx) => (
        <ThemedText key={idx}>{renderRow(row)}</ThemedText>
      ))}
      <ThemedText color="subtle">{makeRule('└', '┴', '┘')}</ThemedText>
    </Box>
  )
}
