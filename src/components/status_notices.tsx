import React from 'react'
import { FIGURES } from '../constants/figures.js'
import { Box } from '../ink/components/box.js'
import type { ThemeColorKey } from './design_system/color.js'
import { ThemedText } from './design_system/themed_text.js'

export type StatusNotice = {
  id: string
  text: string
  level: 'info' | 'warning' | 'error'
}

export type StatusNoticesProps = {
  notices: readonly StatusNotice[]
}

export function StatusNotices({ notices }: StatusNoticesProps): React.ReactNode {
  if (notices.length === 0) return null
  return (
    <Box flexDirection="column" paddingX={1}>
      {notices.map(n => {
        const color: ThemeColorKey =
          n.level === 'error'
            ? 'error'
            : n.level === 'warning'
              ? 'warning'
              : 'suggestion'
        const icon =
          n.level === 'error'
            ? FIGURES.cross
            : n.level === 'warning'
              ? FIGURES.warning
              : FIGURES.info
        return (
          <Box key={n.id} flexDirection="row" gap={1}>
            <ThemedText color={color}>{icon}</ThemedText>
            <ThemedText color={color}>{n.text}</ThemedText>
          </Box>
        )
      })}
    </Box>
  )
}
