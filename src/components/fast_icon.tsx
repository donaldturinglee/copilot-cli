import React from 'react'
import { LIGHTNING_BOLT } from '../constants/figures.js'
import { ThemedText } from './design_system/themed_text.js'

export type FastIconProps = {
  active?: boolean
  shimmer?: boolean
}

export function FastIcon({
  active = true,
  shimmer = false,
}: FastIconProps): React.ReactNode {
  if (!active) return null
  return (
    <ThemedText color={shimmer ? 'fastModeShimmer' : 'fastMode'} bold>
      {LIGHTNING_BOLT}
    </ThemedText>
  )
}
