import React from 'react'
import { BLACK_CIRCLE } from '../constants/figures.js'
import { Box } from '../ink/components/box.js'
import { useBlink } from '../hooks/use_blink.js'
import type { ThemeColorKey } from './design_system/color.js'
import { ThemedText } from './design_system/themed_text.js'

export type ToolUseLoaderProps = {
  isError?: boolean
  isUnresolved?: boolean
  shouldAnimate?: boolean
}

export function ToolUseLoader({
  isError = false,
  isUnresolved = true,
  shouldAnimate = true,
}: ToolUseLoaderProps): React.ReactNode {
  const visible = useBlink(500, isUnresolved && shouldAnimate)
  const color: ThemeColorKey = isError
    ? 'error'
    : isUnresolved
      ? 'claude'
      : 'success'

  return (
    <Box minWidth={2}>
      <ThemedText color={color} dimColor={isUnresolved && !visible}>
        {BLACK_CIRCLE}
      </ThemedText>
    </Box>
  )
}
