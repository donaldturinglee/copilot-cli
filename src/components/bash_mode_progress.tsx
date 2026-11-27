import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'

export type BashModeProgressProps = {
  command: string
  outputLines?: readonly string[]
  elapsedSec?: number
}

export function BashModeProgress({
  command,
  outputLines = [],
  elapsedSec,
}: BashModeProgressProps): React.ReactNode {
  const tail = outputLines.slice(-5)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box flexDirection="row" gap={1}>
        <ThemedText color="bashBorder" bold>
          !
        </ThemedText>
        <ThemedText>{command}</ThemedText>
        {elapsedSec !== undefined ? (
          <ThemedText dimColor>({elapsedSec}s)</ThemedText>
        ) : null}
      </Box>
      {tail.map((line, i) => (
        <ThemedText key={i} dimColor>
          {line}
        </ThemedText>
      ))}
    </Box>
  )
}
