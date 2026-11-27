import React from 'react'
import { Box } from '../../ink/components/box.js'
import type { SelectOptionItem } from './option_map.js'
import { SelectOption } from './select_option.js'
import { useSelectNavigation } from './use_select_navigation.js'
import { useSelectState } from './use_select_state.js'

export type SelectProps<T extends string = string> = {
  options: readonly SelectOptionItem<T>[]
  defaultValue?: T
  visibleOptionCount?: number
  isDisabled?: boolean
  onChange?: (value: T) => void
  onFocus?: (value: T) => void
  onCancel?: () => void
}

export function Select<T extends string = string>({
  options,
  defaultValue,
  visibleOptionCount = 8,
  isDisabled = false,
  onChange,
  onFocus,
  onCancel,
}: SelectProps<T>): React.ReactNode {
  const state = useSelectState({
    options,
    defaultValue,
    visibleOptionCount,
    onChange,
    onFocus,
  })

  useSelectNavigation({
    onNext: state.focusNextOption,
    onPrevious: state.focusPreviousOption,
    onAccept: state.selectFocusedOption,
    onCancel,
    isDisabled,
  })

  return (
    <Box flexDirection="column">
      {state.visibleOptions.map(opt => (
        <SelectOption
          key={opt.value}
          label={opt.label}
          description={opt.description}
          isFocused={!isDisabled && state.focusedValue === opt.value}
          isSelected={state.selectedValue === opt.value}
          disabled={opt.disabled}
        />
      ))}
    </Box>
  )
}
