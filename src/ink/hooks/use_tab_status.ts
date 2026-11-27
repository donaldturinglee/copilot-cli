import { useEffect } from 'react'
import {
  PROGRESS_STATE,
  type ProgressState,
  setProgress,
} from '../termio/osc.js'

export function useTabStatus(
  state: ProgressState,
  percent?: number,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled || !process.stdout.isTTY) return
    process.stdout.write(setProgress(state, percent))
    return () => {
      process.stdout.write(setProgress(PROGRESS_STATE.HIDDEN))
    }
  }, [state, percent, enabled])
}
