import React from 'react'
import { Box } from '../ink/components/box.js'
import type { DiagnosticCheckItem } from '../utilities/doctor_diagnostic.js'
import { StatusIcon } from './design_system/status_icon.js'
import { ThemedText } from './design_system/themed_text.js'

export type DiagnosticsDisplayProps = {
  checks: readonly DiagnosticCheckItem[]
}

export function DiagnosticsDisplay({
  checks,
}: DiagnosticsDisplayProps): React.ReactNode {
  return (
    <Box flexDirection="column" gap={0}>
      {checks.map(check => (
        <Box key={check.id} flexDirection="row" gap={1}>
          <StatusIcon
            status={
              check.status === 'pass'
                ? 'success'
                : check.status === 'warn'
                  ? 'warning'
                  : 'error'
            }
          />
          <ThemedText bold>{check.label}:</ThemedText>
          <ThemedText dimColor>{check.detail}</ThemedText>
        </Box>
      ))}
    </Box>
  )
}
