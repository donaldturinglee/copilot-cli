import React from 'react'
import { Text } from '../ink/components/text.js'
import type { ColorValue } from '../ink/styles.js'
import {
  findMatchRanges,
  splitTextByHighlights,
  type TextHighlightRange,
} from './text_highlighting.js'

export type HighlightMatchProps = {
  text: string
  query?: string
  ranges?: readonly TextHighlightRange[]
  caseSensitive?: boolean
  matchColor?: ColorValue
  matchBold?: boolean
  matchInverse?: boolean
  baseColor?: ColorValue
  dimColor?: boolean
}

export function HighlightMatch({
  text,
  query,
  ranges,
  caseSensitive = false,
  matchColor = 'suggestion',
  matchBold = true,
  matchInverse = false,
  baseColor,
  dimColor,
}: HighlightMatchProps): React.ReactNode {
  const effectiveRanges =
    ranges ?? (query ? findMatchRanges(text, query, caseSensitive) : [])
  const segments = splitTextByHighlights(text, effectiveRanges)

  return (
    <Text color={baseColor} dimColor={dimColor}>
      {segments.map((seg, idx) =>
        seg.highlighted ? (
          <Text
            key={idx}
            color={seg.color ?? matchColor}
            bold={seg.bold ?? matchBold}
            inverse={seg.inverse ?? matchInverse}
          >
            {seg.text}
          </Text>
        ) : (
          <React.Fragment key={idx}>{seg.text}</React.Fragment>
        ),
      )}
    </Text>
  )
}
