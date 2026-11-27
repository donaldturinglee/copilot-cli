import React from 'react'
import { FIGURES } from '../constants/figures.js'
import { Box } from '../ink/components/box.js'
import { Text } from '../ink/components/text.js'

export type ValidationErrorItem = {
  path?: string
  message: string
  severity?: 'error' | 'warning'
}

export type ValidationErrorsListProps = {
  title?: string
  errors: readonly ValidationErrorItem[]
}

export function ValidationErrorsList({
  title,
  errors,
}: ValidationErrorsListProps): React.ReactNode {
  if (errors.length === 0) return null

  return (
    <Box flexDirection="column">
      {title ? (
        <Text bold color="error">
          {title}
        </Text>
      ) : null}
      {errors.map((err, idx) => {
        const isWarn = err.severity === 'warning'
        return (
          <Box key={idx} flexDirection="row" gap={1}>
            <Text color={isWarn ? 'warning' : 'error'}>
              {isWarn ? FIGURES.warning : FIGURES.cross}
            </Text>
            <Text color={isWarn ? 'warning' : 'error'}>
              {err.path ? `${err.path}: ${err.message}` : err.message}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
