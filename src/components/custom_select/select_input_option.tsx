import React from 'react'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from '../design_system/themed_text.js'
import { useSelectInput } from './use_select_input.js'

export type SelectInputOptionProps = {
  placeholder?: string
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  isFocused: boolean
}

export function SelectInputOption({
  placeholder = 'Type custom value…',
  value,
  onChange,
  onSubmit,
  isFocused,
}: SelectInputOptionProps): React.ReactNode {
  useSelectInput({ value, onChange, onSubmit, isActive: isFocused })

  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText color={isFocused ? 'suggestion' : 'inactive'}>
        {isFocused ? FIGURES.pointer : ' '}
      </ThemedText>
      {value.length > 0 ? (
        <ThemedText color={isFocused ? 'suggestion' : 'text'}>
          {value}
        </ThemedText>
      ) : (
        <ThemedText dimColor>{placeholder}</ThemedText>
      )}
    </Box>
  )
}
