import React from 'react'
import { ModalProvider } from '../context/modal_context.js'
import { OverlayProvider } from '../context/overlay_context.js'
import { PromptOverlayProvider } from '../context/prompt_overlay_context.js'
import { QueuedMessageProvider } from '../context/queued_message_context.js'
import { StatsProvider } from '../context/stats.js'
import { KeybindingSetup } from '../keybindings/keybinding_provider_setup.js'
import { AppStateProvider } from '../state/app_state.js'
import type { AppState, AppStateStore } from '../state/app_state_store.js'
import type { ThemeName } from '../types/forward.js'
import { getGlobalConfig } from '../utilities/config.js'
import { ThemeProvider } from './design_system/theme_provider.js'
import { SentryErrorBoundary } from './sentry_error_boundary.js'

export type AppProps = {
  children: React.ReactNode
  initialState?: Partial<AppState>
  store?: AppStateStore
  initialTheme?: ThemeName
  enableKeybindingWatcher?: boolean
}

/**
 * Top-level interactive React provider stack wrapping the REPL and startup
 * dialogs.
 */
export function App({
  children,
  initialState,
  store,
  initialTheme,
  enableKeybindingWatcher = false,
}: AppProps): React.ReactNode {
  const theme = initialTheme ?? getGlobalConfig().theme ?? 'dark'
  return (
    <AppStateProvider initialState={initialState} store={store}>
      <ThemeProvider initialTheme={theme}>
        <OverlayProvider>
          <ModalProvider>
            <PromptOverlayProvider>
              <QueuedMessageProvider>
                <StatsProvider>
                  <KeybindingSetup enableWatcher={enableKeybindingWatcher}>
                    <SentryErrorBoundary>{children}</SentryErrorBoundary>
                  </KeybindingSetup>
                </StatsProvider>
              </QueuedMessageProvider>
            </PromptOverlayProvider>
          </ModalProvider>
        </OverlayProvider>
      </ThemeProvider>
    </AppStateProvider>
  )
}
