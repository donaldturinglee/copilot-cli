import React from 'react'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from '../design_system/themed_text.js'

export type SelectOptionProps = {
  label: string
  description?: string
  isFocused: boolean
  isSelected: boolean
  disabled?: boolean
  multi?: boolean
}

export function SelectOption({
  label,
  description,
  isFocused,
  isSelected,
  disabled = false,
  multi = false,
}: SelectOptionProps): React.ReactNode {
  const prefix = isFocused ? FIGURES.pointer : ' '
  const check = multi
    ? isSelected
      ? FIGURES.checkboxOn
      : FIGURES.checkboxOff
    : isSelected
      ? FIGURES.tick
      : ''

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <ThemedText color={isFocused ? 'suggestion' : 'inactive'}>
          {prefix}
        </ThemedText>
        {multi ? (
          <ThemedText color={isSelected ? 'success' : 'inactive'}>
            {check}
          </ThemedText>
        ) : null}
        <ThemedText
          color={
            disabled
              ? 'inactive'
              : isFocused
                ? 'suggestion'
                : isSelected
                  ? 'success'
                  : 'text'
          }
          bold={isFocused}
          dimColor={disabled}
        >
          {label}
        </ThemedText>
        {!multi && isSelected ? (
          <ThemedText color="success">{FIGURES.tick}</ThemedText>
        ) : null}
      </Box>
      {description ? (
        <Box paddingLeft={multi ? 4 : 2}>
          <ThemedText dimColor>{description}</ThemedText>
        </Box>
      ) : null}
    </Box>
  )
}
