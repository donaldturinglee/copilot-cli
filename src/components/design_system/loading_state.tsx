import React from 'react'
import { Box } from '../../ink/components/box.js'
import { useAnimationFrame } from '../../ink/hooks/use_animation_frame.js'
import type { ColorValue } from '../../ink/styles.js'
import { ThemedText } from './themed_text.js'

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type LoadingStateProps = {
  label?: string
  color?: ColorValue
  animate?: boolean
}

export function LoadingState({
  label = 'Loading…',
  color = 'claude',
  animate = true,
}: LoadingStateProps): React.ReactNode {
  const now = useAnimationFrame(80, animate)
  const idx = animate ? Math.floor(now / 80) % BRAILLE_FRAMES.length : 0
  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText color={color}>{BRAILLE_FRAMES[idx]}</ThemedText>
      <ThemedText dimColor>{label}</ThemedText>
    </Box>
  )
}
