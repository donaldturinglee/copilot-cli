/**
 * React subscription hook for `compactWarningStore`.
 */

import { useSyncExternalStore } from 'react'
import { compactWarningStore } from './compact_warning_state.js'

/**
 * Returns `true` when the context-low warning banner is temporarily suppressed
 * following a microcompact or manual `/compact`.
 */
export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getState,
    compactWarningStore.getState,
  )
}
