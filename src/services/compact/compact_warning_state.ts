/**
 * React-free store controlling suppression of the context-low warning banner
 * immediately after microcompact or manual `/compact` frees space.
 */

import { createStore } from '../../state/store.js'

export const compactWarningStore = createStore<boolean>(false)

/**
 * Suppresses the context-low warning banner until the next model turn resets it.
 */
export function suppressCompactWarning(): void {
  compactWarningStore.setState(() => true)
}

/**
 * Clears any active context-low warning suppression at the start of a query turn.
 */
export function clearCompactWarningSuppression(): void {
  compactWarningStore.setState(() => false)
}
