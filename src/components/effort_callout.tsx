import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'

export type EffortCalloutProps = {
  effort: string
}

export function EffortCallout({ effort }: EffortCalloutProps): React.ReactNode {
  return (
    <Box paddingX={1}>
      <ThemedText color="suggestion">
        Effort set to {effort} — run /effort to adjust reasoning depth.
      </ThemedText>
    </Box>
  )
}
