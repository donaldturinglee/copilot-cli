import React from 'react'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from './themed_text.js'

export type ListItemProps = {
  label: React.ReactNode
  description?: React.ReactNode
  isFocused?: boolean
  isSelected?: boolean
  disabled?: boolean
  badge?: React.ReactNode
}

export function ListItem({
  label,
  description,
  isFocused = false,
  isSelected = false,
  disabled = false,
  badge,
}: ListItemProps): React.ReactNode {
  const indicator = isFocused ? FIGURES.pointer : ' '
  const labelColor = disabled
    ? 'inactive'
    : isFocused
      ? 'suggestion'
      : isSelected
        ? 'success'
        : 'text'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <ThemedText color={isFocused ? 'suggestion' : 'inactive'}>
          {indicator}
        </ThemedText>
        <ThemedText color={labelColor} bold={isFocused} dimColor={disabled}>
          {label}
        </ThemedText>
        {isSelected ? <ThemedText color="success">{FIGURES.tick}</ThemedText> : null}
        {badge}
      </Box>
      {description ? (
        <Box paddingLeft={2}>
          <ThemedText dimColor>{description}</ThemedText>
        </Box>
      ) : null}
    </Box>
  )
}
