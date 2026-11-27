/**
 * Helpers for mutating `ToolPermissionContext` in `AppStateStore`.
 */

import type { AppState } from '../../state/app_state_store.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { applyPermissionUpdates } from '../../utilities/permissions/rule_matching.js'

export function updateToolPermissionContext(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  updates: readonly PermissionUpdate[],
): void {
  if (updates.length === 0) return
  setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdates(
      prev.toolPermissionContext,
      updates,
    ),
  }))
}
