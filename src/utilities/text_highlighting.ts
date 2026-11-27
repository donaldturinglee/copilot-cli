export type TextHighlightRange = {
  start: number
  end: number
  color?: string
  bold?: boolean
  inverse?: boolean
}

export type HighlightSegment = {
  text: string
  highlighted: boolean
  color?: string
  bold?: boolean
  inverse?: boolean
}

/**
 * Partition `text` into ordered non-overlapping segments according to
 * highlight ranges. Overlapping ranges are merged with earlier ranges
 * taking precedence.
 */
export function splitTextByHighlights(
  text: string,
  ranges: readonly TextHighlightRange[],
): HighlightSegment[] {
  if (ranges.length === 0 || text.length === 0) {
    return text.length > 0 ? [{ text, highlighted: false }] : []
  }

  const sorted = [...ranges]
    .filter(r => r.end > r.start && r.start < text.length && r.end > 0)
    .map(r => ({
      ...r,
      start: Math.max(0, r.start),
      end: Math.min(text.length, r.end),
    }))
    .sort((a, b) => a.start - b.start)

  const segments: HighlightSegment[] = []
  let cursor = 0

  for (const r of sorted) {
    const start = Math.max(cursor, r.start)
    if (start >= r.end) continue

    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), highlighted: false })
    }
    segments.push({
      text: text.slice(start, r.end),
      highlighted: true,
      color: r.color,
      bold: r.bold,
      inverse: r.inverse,
    })
    cursor = r.end
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false })
  }

  return segments
}

/**
 * Find all case-insensitive substring match ranges of `query` inside `text`.
 */
export function findMatchRanges(
  text: string,
  query: string,
  caseSensitive = false,
): TextHighlightRange[] {
  if (!query) return []
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: TextHighlightRange[] = []
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    ranges.push({ start: idx, end: idx + needle.length })
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return ranges
}
