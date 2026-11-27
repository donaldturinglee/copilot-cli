import { useMemo } from 'react'
import { useSettings } from './use_settings.js'

export function useDynamicConfig<T>(key: string, defaultValue: T): T {
  const settings = useSettings() as Record<string, unknown>
  return useMemo(() => {
    const value = settings[key]
    return value !== undefined ? (value as T) : defaultValue
  }, [settings, key, defaultValue])
}
