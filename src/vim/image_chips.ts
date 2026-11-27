const ATOMIC_TOKEN_RE =
  /\[Image #\d+\]|\[Pasted text #\d+(?: \+\d+ lines)?\]/g

export type AtomicChipSpan = {
  start: number
  end: number
  token: string
}

/**
 * Find all atomic `[Image #N]` and `[Pasted text #N ...]` spans in the buffer.
 */
export function findChipSpans(text: string): AtomicChipSpan[] {
  const spans: AtomicChipSpan[] = []
  for (const m of text.matchAll(ATOMIC_TOKEN_RE)) {
    const start = m.index ?? 0
    spans.push({ start, end: start + m[0].length, token: m[0] })
  }
  return spans
}

/**
 * Return the chip span enclosing `offset` (strictly inside, or at `start` when
 * `includeStart` is true).
 */
export function findEnclosingChip(
  text: string,
  offset: number,
  includeStart = false,
): AtomicChipSpan | null {
  for (const span of findChipSpans(text)) {
    if (includeStart) {
      if (offset >= span.start && offset < span.end) return span
    } else {
      if (offset > span.start && offset < span.end) return span
    }
  }
  return null
}

/**
 * Snap a cursor position out of the interior of any `[Image #N]` chip so Vim
 * motions never strand the cursor mid-token.
 */
export function snapCursorOutOfChip(
  text: string,
  offset: number,
  direction: 'left' | 'right' | 'nearest' = 'left',
): number {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const chip = findEnclosingChip(text, clamped, false)
  if (!chip) return clamped
  if (direction === 'right') return chip.end
  if (direction === 'left') return chip.start
  return clamped - chip.start <= chip.end - clamped ? chip.start : chip.end
}

/**
 * Expand a `[start, end)` deletion/change range so that if either endpoint
 * intersects an atomic `[Image #N]` token, the entire token is covered atomically
 * rather than leaving corrupted fragments like `[Ima` or `#1]`.
 */
export function expandRangeAcrossChips(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, text.length))
  let e = Math.max(s, Math.min(end, text.length))
  for (const chip of findChipSpans(text)) {
    if (e > chip.start && s < chip.end) {
      s = Math.min(s, chip.start)
      e = Math.max(e, chip.end)
    }
  }
  return { start: s, end: e }
}
