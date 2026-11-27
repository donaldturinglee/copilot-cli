import React from 'react'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import { stringWidth } from '../../ink/string_width.js'
import type { ColorValue } from '../../ink/styles.js'
import { ThemedText } from './themed_text.js'

export type DividerProps = {
  width?: number
  title?: string
  dividerChar?: string
  color?: ColorValue
  titleColor?: ColorValue
  dimColor?: boolean
}

export function Divider({
  width = 60,
  title,
  dividerChar = FIGURES.line,
  color = 'subtle',
  titleColor = 'text',
  dimColor = false,
}: DividerProps): React.ReactNode {
  const safeW = Math.max(4, Math.floor(width))
  if (!title) {
    return (
      <Box>
        <ThemedText color={color} dimColor={dimColor}>
          {dividerChar.repeat(safeW)}
        </ThemedText>
      </Box>
    )
  }

  const label = ` ${title} `
  const labelW = stringWidth(label)
  const remaining = Math.max(0, safeW - labelW)
  const leftW = Math.min(2, Math.floor(remaining / 2))
  const rightW = Math.max(0, remaining - leftW)

  return (
    <Box flexDirection="row">
      <ThemedText color={color} dimColor={dimColor}>
        {dividerChar.repeat(leftW)}
      </ThemedText>
      <ThemedText color={titleColor} bold>
        {label}
      </ThemedText>
      <ThemedText color={color} dimColor={dimColor}>
        {dividerChar.repeat(rightW)}
      </ThemedText>
    </Box>
  )
}
