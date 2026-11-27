import { useEffect, useRef } from 'react'
import { settingsChangeDetector } from '../utilities/settings/change_detector.js'
import type { SettingSource } from '../utilities/settings/constants.js'

export function useSettingsChange(
  onChange: (source: SettingSource) => void,
  enabled = true,
): void {
  const cbRef = useRef(onChange)
  cbRef.current = onChange

  useEffect(() => {
    if (!enabled) return
    return settingsChangeDetector.subscribe(source => {
      cbRef.current(source)
    })
  }, [enabled])
}
