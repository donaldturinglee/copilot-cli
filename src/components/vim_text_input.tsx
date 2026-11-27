import React from 'react'
import { useVimInput } from '../hooks/use_vim_input.js'
import { Box } from '../ink/components/box.js'
import { Text } from '../ink/components/text.js'
import type { VimMode } from '../vim/types.js'
import { ThemedText } from './design_system/themed_text.js'

export type VimTextInputProps = {
  value: string
  placeholder?: string
  initialMode?: VimMode
  isActive?: boolean
  onChange: (value: string, cursor: number, mode: VimMode) => void
  onSubmit?: (value: string) => void
  onModeChange?: (mode: VimMode) => void
}

export function VimTextInput({
  value,
  placeholder = '',
  initialMode = 'INSERT',
  isActive = true,
  onChange,
  onSubmit,
  onModeChange,
}: VimTextInputProps): React.ReactNode {
  const { engine, mode, modeLabel } = useVimInput({
    initialValue: value,
    initialMode,
    isActive,
    onChange,
    onSubmit,
    onModeChange,
  })

  if (engine.doc.text !== value) {
    engine.setDocument(value, Math.min(engine.doc.cursor, value.length))
  }

  const text = engine.doc.text
  const cursor = engine.doc.cursor

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row">
        {text.length === 0 ? (
          <ThemedText dimColor>{placeholder}</ThemedText>
        ) : (
          <Text>
            {text.slice(0, cursor)}
            <Text inverse>{text[cursor] ?? ' '}</Text>
            {text.slice(cursor + 1)}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" marginTop={0}>
        <ThemedText color={mode === 'NORMAL' ? 'warning' : 'suggestion'} bold>
          -- {modeLabel} --
        </ThemedText>
      </Box>
    </Box>
  )
}
