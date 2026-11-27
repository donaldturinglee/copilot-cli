import React from 'react'
import { Box } from '../../ink/components/box.js'
import type { SelectOptionItem } from './option_map.js'
import { SelectOption } from './select_option.js'
import { useMultiSelectState } from './use_multi_select_state.js'
import { useSelectNavigation } from './use_select_navigation.js'

export type SelectMultiProps<T extends string = string> = {
  options: readonly SelectOptionItem<T>[]
  defaultValues?: readonly T[]
  visibleOptionCount?: number
  isDisabled?: boolean
  onChange?: (values: T[]) => void
  onSubmit?: (values: T[]) => void
  onCancel?: () => void
}

export function SelectMulti<T extends string = string>({
  options,
  defaultValues = [],
  visibleOptionCount = 8,
  isDisabled = false,
  onChange,
  onSubmit,
  onCancel,
}: SelectMultiProps<T>): React.ReactNode {
  const state = useMultiSelectState({
    options,
    defaultValues,
    visibleOptionCount,
    onChange,
    onSubmit,
  })

  useSelectNavigation({
    onNext: state.focusNextOption,
    onPrevious: state.focusPreviousOption,
    onToggle: state.toggleFocusedOption,
    onAccept: state.submit,
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
          isSelected={state.selectedValues.includes(opt.value)}
          disabled={opt.disabled}
          multi={true}
        />
      ))}
    </Box>
  )
}
