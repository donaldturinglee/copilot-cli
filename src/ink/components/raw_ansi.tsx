import React from 'react'

export type RawAnsiProps = {
  /** Pre-formatted ANSI lines written directly into the packed Screen buffer. */
  lines: string[]
  /** Fixed display column width of this O(1) Yoga leaf. */
  width: number
}

/**
 * O(1) Yoga leaf for pre-formatted multi-line ANSI output (used by
 * `<StructuredDiff>` and `<HighlightedCode>` to avoid creating N Yoga nodes).
 */
export function RawAnsi({ lines, width }: RawAnsiProps): React.ReactNode {
  return React.createElement('ink-raw-ansi', {
    rawAnsiLines: lines,
    rawAnsiWidth: Math.max(1, Math.floor(width)),
    style: {
      width: Math.max(1, Math.floor(width)),
      height: lines.length,
      flexShrink: 0,
    },
  })
}
