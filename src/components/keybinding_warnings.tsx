import React from 'react'
import { FIGURES } from '../constants/figures.js'
import { Box } from '../ink/components/box.js'
import { Text } from '../ink/components/text.js'
import type { KeybindingWarning } from '../keybindings/validate.js'

export type KeybindingWarningsProps = {
  warnings: readonly KeybindingWarning[]
}

export function KeybindingWarnings({
  warnings,
}: KeybindingWarningsProps): React.ReactNode {
  if (warnings.length === 0) return null

  return (
    <Box flexDirection="column" gap={0}>
      {warnings.map((w, idx) => (
        <Box key={idx} flexDirection="row" gap={1}>
          <Text color={w.severity === 'error' ? 'error' : 'warning'}>
            {w.severity === 'error' ? FIGURES.cross : FIGURES.warning}
          </Text>
          <Text color={w.severity === 'error' ? 'error' : 'warning'}>
            {w.message}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
