/**
 * React lifecycle hook loading active plugins, commands, agents, hooks, output
 * styles, MCP servers, and LSP servers on REPL startup and reconciling
 * `extraKnownMarketplaces` in the background.
 */

import { useEffect, useRef } from 'react'
import { useSetAppState } from '../state/app_state.js'
import { isBareMode } from '../utilities/env_utils.js'
import { reconcileMarketplacesAndPlugins } from '../utilities/plugins/reconciler.js'
import { refreshActivePlugins } from '../utilities/plugins/refresh.js'

/**
 * Initializes plugins in `AppState` on mount and runs non-blocking background
 * marketplace reconciliation.
 */
export function useManagePlugins(enabled = true): void {
  const setAppState = useSetAppState()
  const didRunRef = useRef(false)

  useEffect(() => {
    if (!enabled || isBareMode() || didRunRef.current) {
      return
    }
    didRunRef.current = true

    void refreshActivePlugins(setAppState)
      .then(() =>
        reconcileMarketplacesAndPlugins({ updateMemorySnapshot: false }),
      )
      .then(reconciled => {
        if (reconciled.changed) {
          setAppState(prev => ({
            ...prev,
            plugins: {
              ...prev.plugins,
              needsRefresh: true,
            },
          }))
        }
      })
      .catch(() => {})
  }, [enabled, setAppState])
}
