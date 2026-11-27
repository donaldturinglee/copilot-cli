import React, { useCallback } from 'react'
import { useInputBuffer } from '../hooks/use_input_buffer.js'
import { useTextInput } from '../hooks/use_text_input.js'
import { BaseTextInput } from './base_text_input.js'

export type TextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  placeholder?: string
  mask?: string
  multiline?: boolean
  isActive?: boolean
  viewportWidth?: number
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  mask,
  multiline = false,
  isActive = true,
  viewportWidth = 80,
}: TextInputProps): React.ReactNode {
  const { controller, notify } = useInputBuffer(value)
  if (controller.text !== value) {
    controller.setValue(value, Math.min(controller.cursor, value.length), false)
  }

  const handleChange = useCallback(
    (next: string) => {
      onChange(next)
      notify()
    },
    [onChange, notify],
  )

  useTextInput({
    controller,
    onChange: handleChange,
    onSubmit,
    multiline,
    isActive,
  })

  return (
    <BaseTextInput
      value={controller.text}
      cursor={controller.cursor}
      placeholder={placeholder}
      mask={mask}
      multiline={multiline}
      showCursor={isActive}
      viewportWidth={viewportWidth}
    />
  )
}
