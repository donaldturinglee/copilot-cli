import { setMainLoopModelOverride } from '../bootstrap/state.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../types/permissions.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managed_env.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/session_state.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { AppState } from './app_state_store.js'

const authCacheInvalidators = new Set<() => void>()

/**
 * Registers an auth/credential cache invalidation callback invoked whenever
 * `AppState.settings` changes (wired by Phase 2 auth modules).
 */
export function registerSettingsChangeAuthCacheInvalidator(
  invalidator: () => void,
): () => void {
  authCacheInvalidators.add(invalidator)
  return () => {
    authCacheInvalidators.delete(invalidator)
  }
}

/**
 * Restores persisted external session metadata onto an AppState snapshot.
 */
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => {
    let next = prev
    if (typeof metadata.permission_mode === 'string') {
      const mode = permissionModeFromString(metadata.permission_mode)
      if (mode !== next.toolPermissionContext.mode) {
        next = {
          ...next,
          toolPermissionContext: {
            ...next.toolPermissionContext,
            mode,
          },
        }
      }
    }
    if (typeof metadata.is_ultraplan_mode === 'boolean') {
      if (next.isUltraplanMode !== metadata.is_ultraplan_mode) {
        next = {
          ...next,
          isUltraplanMode: metadata.is_ultraplan_mode,
        }
      }
    }
    return next
  }
}

/**
 * Synchronous diff-driven side effects executed whenever AppState transitions.
 */
export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}): void {
  if (
    newState.toolPermissionContext.mode !== oldState.toolPermissionContext.mode
  ) {
    const prevExternal = toExternalPermissionMode(
      oldState.toolPermissionContext.mode,
    )
    const newExternal = toExternalPermissionMode(
      newState.toolPermissionContext.mode,
    )
    if (prevExternal !== newExternal) {
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newState.toolPermissionContext.mode)
  }

  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    if (newState.mainLoopModel === null) {
      updateSettingsForSource('userSettings', { model: undefined })
      setMainLoopModelOverride(null)
    } else {
      updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
      setMainLoopModelOverride(newState.mainLoopModel)
    }
  }

  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    const currentConfig = getGlobalConfig()
    if (
      currentConfig.showExpandedTodos !== showExpandedTodos ||
      currentConfig.showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  if (newState.verbose !== oldState.verbose) {
    if (getGlobalConfig().verbose !== newState.verbose) {
      saveGlobalConfig(current => ({
        ...current,
        verbose: newState.verbose,
      }))
    }
  }

  if (newState.settings !== oldState.settings) {
    try {
      for (const invalidate of authCacheInvalidators) {
        invalidate()
      }
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
