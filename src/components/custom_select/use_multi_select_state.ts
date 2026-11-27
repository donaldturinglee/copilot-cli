import { useCallback, useMemo, useState } from 'react'
import { OptionMap, type SelectOptionItem } from './option_map.js'

export type UseMultiSelectStateOptions<T extends string = string> = {
  options: readonly SelectOptionItem<T>[]
  defaultValues?: readonly T[]
  visibleOptionCount?: number
  onChange?: (values: T[]) => void
  onSubmit?: (values: T[]) => void
}

export type MultiSelectState<T extends string = string> = {
  focusedValue: T | undefined
  selectedValues: T[]
  visibleOptions: SelectOptionItem<T>[]
  focusNextOption: () => void
  focusPreviousOption: () => void
  toggleFocusedOption: () => void
  submit: () => void
}

export function useMultiSelectState<T extends string = string>({
  options,
  defaultValues = [],
  visibleOptionCount = 8,
  onChange,
  onSubmit,
}: UseMultiSelectStateOptions<T>): MultiSelectState<T> {
  const map = useMemo(() => new OptionMap(options), [options])
  const [focusedValue, setFocusedValue] = useState<T | undefined>(
    () => options.find(o => !o.disabled)?.value,
  )
  const [selectedValues, setSelectedValues] = useState<T[]>(() => [
    ...defaultValues,
  ])

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
    [options, focusedValue, map],
  )

  const toggleFocusedOption = useCallback(() => {
    if (!focusedValue) return
    const entry = map.get(focusedValue)
    if (!entry || entry.disabled) return
    setSelectedValues(prev => {
      const exists = prev.includes(focusedValue)
      const next = exists
        ? prev.filter(v => v !== focusedValue)
        : [...prev, focusedValue]
      onChange?.(next)
      return next
    })
  }, [focusedValue, map, onChange])

  const submit = useCallback(() => {
    onSubmit?.(selectedValues)
  }, [onSubmit, selectedValues])

  const focusedIdx = focusedValue ? (map.get(focusedValue)?.index ?? 0) : 0
  const maxVisible = Math.max(1, visibleOptionCount)
  const from = Math.max(
    0,
    Math.min(
      focusedIdx - Math.floor(maxVisible / 2),
      Math.max(0, options.length - maxVisible),
    ),
  )
  const visibleOptions = options.slice(from, from + maxVisible)

  return {
    focusedValue,
    selectedValues,
    visibleOptions,
    focusNextOption: () => moveFocus(1),
    focusPreviousOption: () => moveFocus(-1),
    toggleFocusedOption,
    submit,
  }
}
