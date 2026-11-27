import React from 'react'
import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
} from '../constants/figures.js'
import type { EffortValue } from '../types/forward.js'
import { ThemedText } from './design_system/themed_text.js'

export function getEffortGlyph(effort: EffortValue | undefined): string {
  switch (effort) {
    case 'low':
      return EFFORT_LOW
    case 'medium':
      return EFFORT_MEDIUM
    case 'high':
      return EFFORT_HIGH
    case 'max':
      return EFFORT_MAX
    default:
      return EFFORT_MEDIUM
  }
}

export type EffortIndicatorProps = {
  effort?: EffortValue
  showLabel?: boolean
}

export function EffortIndicator({
  effort = 'medium',
  showLabel = false,
}: EffortIndicatorProps): React.ReactNode {
  const glyph = getEffortGlyph(effort)
  return (
    <ThemedText color="claude">
      {showLabel ? `${glyph} ${effort}` : glyph}
    </ThemedText>
  )
}
