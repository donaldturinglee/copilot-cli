/**
 * React hook watching `AppState.fileHistory.trackedFiles` and surfacing
 * `<LspRecommendationMenu />` at most once per session when an uninstalled LSP
 * plugin matches a newly tracked file extension.
 */

import { extname } from 'path'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  getIsRemoteMode,
  hasShownLspRecommendationThisSession,
  setLspRecommendationShownThisSession,
} from '../bootstrap/state.js'
import {
  LspRecommendationMenu,
  type LspRecommendationChoice,
} from '../components/lsp_recommendation/lsp_recommendation_menu.js'
import { installPluginOp } from '../services/plugins/plugin_operations.js'
import { useAppState, useSetAppState } from '../state/app_state.js'
import { saveGlobalConfig } from '../utilities/config.js'
import {
  addToNeverSuggestLspPlugin,
  getMatchingLspPlugins,
  incrementLspIgnoredCount,
} from '../utilities/plugins/lsp_recommendation.js'
import { refreshActivePlugins } from '../utilities/plugins/refresh.js'

const TIMEOUT_IGNORE_THRESHOLD_MS = 28_000

interface ActiveRecommendation {
  pluginId: string
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  shownAt: number
}

/**
 * Returns an optional `<LspRecommendationMenu />` overlay node when a matching
 * LSP plugin is available for a tracked workspace file.
 */
export function useLspPluginRecommendation(enabled = true): React.ReactNode {
  const trackedFiles = useAppState(s => s.fileHistory.trackedFiles)
  const setAppState = useSetAppState()
  const checkedFilesRef = useRef(new Set<string>())
  const checkingRef = useRef(false)
  const [active, setActive] = useState<ActiveRecommendation | null>(null)

  useEffect(() => {
    if (
      !enabled ||
      getIsRemoteMode() ||
      hasShownLspRecommendationThisSession() ||
      checkingRef.current
    ) {
      return
    }

    const unchecked: string[] = []
    for (const filePath of trackedFiles) {
      if (!checkedFilesRef.current.has(filePath)) {
        checkedFilesRef.current.add(filePath)
        unchecked.push(filePath)
      }
    }
    if (unchecked.length === 0) {
      return
    }

    checkingRef.current = true
    void (async () => {
      try {
        for (const filePath of unchecked) {
          if (hasShownLspRecommendationThisSession()) break
          const matches = await getMatchingLspPlugins(filePath)
          if (matches[0]) {
            setLspRecommendationShownThisSession(true)
            setActive({
              pluginId: matches[0].pluginId,
              pluginName: matches[0].pluginName,
              pluginDescription: matches[0].description,
              fileExtension: extname(filePath) || 'source',
              shownAt: Date.now(),
            })
            break
          }
        }
      } finally {
        checkingRef.current = false
      }
    })()
  }, [enabled, trackedFiles])

  const handleResponse = useCallback(
    (choice: LspRecommendationChoice) => {
      if (!active) return
      const current = active
      setActive(null)

      if (choice === 'yes') {
        void installPluginOp(current.pluginId, 'user')
          .then(() => refreshActivePlugins(setAppState))
          .catch(() => {})
      } else if (choice === 'no') {
        if (Date.now() - current.shownAt >= TIMEOUT_IGNORE_THRESHOLD_MS) {
          incrementLspIgnoredCount()
        }
      } else if (choice === 'never') {
        addToNeverSuggestLspPlugin(current.pluginId)
      } else if (choice === 'disable') {
        saveGlobalConfig(prev => ({
          ...prev,
          lspRecommendationDisabled: true,
        }))
      }
    },
    [active, setAppState],
  )

  if (!active) {
    return null
  }

  return (
    <LspRecommendationMenu
      pluginName={active.pluginName}
      pluginDescription={active.pluginDescription}
      fileExtension={active.fileExtension}
      onResponse={handleResponse}
    />
  )
}
