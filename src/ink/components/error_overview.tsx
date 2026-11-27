import React from 'react'
import { Box } from './box.js'
import { Text } from './text.js'

export type ErrorOverviewProps = {
  error: Error
}

export function ErrorOverview({ error }: ErrorOverviewProps): React.ReactNode {
  const stackLines = (error.stack ?? '')
    .split('\n')
    .slice(1, 8)
    .map(l => l.trim())

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="error">
      <Text bold color="error">
        ERROR: {error.message || 'Unhandled rendering error'}
      </Text>
      {stackLines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  )
}
