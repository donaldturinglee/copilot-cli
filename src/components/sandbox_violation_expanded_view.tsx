import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedBox } from './design_system/themed_box.js'
import { ThemedText } from './design_system/themed_text.js'

export type SandboxViolation = {
  timestamp: string
  command: string
  reason: string
}

export type SandboxViolationExpandedViewProps = {
  violations: readonly SandboxViolation[]
}

export function SandboxViolationExpandedView({
  violations,
}: SandboxViolationExpandedViewProps): React.ReactNode {
  if (violations.length === 0) return null
  return (
    <ThemedBox
      borderStyle="single"
      borderColor="warning"
      paddingX={1}
      flexDirection="column"
    >
      <ThemedText color="warning" bold>
        Sandbox Violations ({violations.length})
      </ThemedText>
      {violations.slice(-5).map((v, idx) => (
        <Box key={idx} flexDirection="row" gap={1}>
          <ThemedText dimColor>{v.timestamp}</ThemedText>
          <ThemedText color="error">{v.reason}</ThemedText>
          <ThemedText dimColor>({v.command})</ThemedText>
        </Box>
      ))}
    </ThemedBox>
  )
}
