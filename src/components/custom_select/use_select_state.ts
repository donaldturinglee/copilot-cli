import { useCallback, useMemo, useState } from 'react'
import { OptionMap, type SelectOptionItem } from './option_map.js'

export type UseSelectStateOptions<T extends string = string> = {
  options: readonly SelectOptionItem<T>[]
  defaultValue?: T
  visibleOptionCount?: number
  onChange?: (value: T) => void
  onFocus?: (value: T) => void
}

export type SelectState<T extends string = string> = {
  focusedValue: T | undefined
  selectedValue: T | undefined
  visibleOptions: SelectOptionItem<T>[]
  visibleFromIndex: number
  visibleToIndex: number
  focusNextOption: () => void
  focusPreviousOption: () => void
  selectFocusedOption: () => void
  setFocusedValue: (value: T) => void
}

export function useSelectState<T extends string = string>({
  options,
  defaultValue,
  visibleOptionCount = 8,
  onChange,
  onFocus,
}: UseSelectStateOptions<T>): SelectState<T> {
  const map = useMemo(() => new OptionMap(options), [options])
  const initialFocus =
    defaultValue && map.get(defaultValue)
      ? defaultValue
      : options.find(o => !o.disabled)?.value

  const [focusedValue, setFocusedValueState] = useState<T | undefined>(
    initialFocus,
  )
  const [selectedValue, setSelectedValue] = useState<T | undefined>(defaultValue)

  const setFocusedValue = useCallback(
    (value: T) => {
      setFocusedValueState(value)
      onFocus?.(value)
    },
    [onFocus],
  )

  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      if (options.length === 0) return
      const curIdx = focusedValue ? (map.get(focusedValue)?.index ?? 0) : 0
      for (let step = 1; step <= options.length; step++) {
        const nextIdx =
          (curIdx + delta * step + options.length) % options.length
        const candidate = options[nextIdx]!
        if (!candidate.disabled) {
          setFocusedValue(candidate.value)
          return
        }
      }
    },
    [options, focusedValue, map, setFocusedValue],
  )

  const focusNextOption = useCallback(() => moveFocus(1), [moveFocus])
  const focusPreviousOption = useCallback(() => moveFocus(-1), [moveFocus])

  const selectFocusedOption = useCallback(() => {
    if (!focusedValue) return
    const entry = map.get(focusedValue)
    if (!entry || entry.disabled) return
    setSelectedValue(focusedValue)
    onChange?.(focusedValue)
  }, [focusedValue, map, onChange])

  const focusedIdx = focusedValue ? (map.get(focusedValue)?.index ?? 0) : 0
  const maxVisible = Math.max(1, visibleOptionCount)
  const visibleFromIndex = Math.max(
    0,
    Math.min(
      focusedIdx - Math.floor(maxVisible / 2),
      Math.max(0, options.length - maxVisible),
    ),
  )
  const visibleToIndex = Math.min(options.length, visibleFromIndex + maxVisible)
  const visibleOptions = options.slice(visibleFromIndex, visibleToIndex)

  return {
    focusedValue,
    selectedValue,
    visibleOptions,
    visibleFromIndex,
    visibleToIndex,
    focusNextOption,
    focusPreviousOption,
    selectFocusedOption,
    setFocusedValue,
  }
}
