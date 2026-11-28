/**
 * Process-wide singleton coordinator for `LSPServerManager` with generation
 * fencing, passive diagnostic registration, and `/reload-plugins` re-init.
 */

import { registerCleanup } from '../../utilities/cleanup_registry.js'
import { isBareMode } from '../../utilities/env_utils.js'
import { registerPluginLspReinitializer } from '../../utilities/plugins/refresh.js'
import { LSPServerManager } from './lsp_server_manager.js'
import { registerLspNotificationHandlers } from './passive_feedback.js'
import type { ScopedLspServerConfig } from './types.js'

export type LspInitializationState =
  | 'not-started'
  | 'pending'
  | 'success'
  | 'failed'

let lspManagerInstance: LSPServerManager | null = null
let initializationState: LspInitializationState = 'not-started'
let initializationError: Error | undefined
let initializationGeneration = 0
let initializationPromise: Promise<void> | null = null

/**
 * Initializes the singleton `LSPServerManager` asynchronously (registering
 * configured servers without spawning child processes until a matching file is
 * touched).
 */
export function initializeLspServerManager(
  serversOverride?: Record<string, ScopedLspServerConfig>,
): Promise<void> {
  if (isBareMode() && !serversOverride) {
    return Promise.resolve()
  }

  const generation = ++initializationGeneration
  const manager = new LSPServerManager()
  lspManagerInstance = manager
  initializationState = 'pending'
  initializationError = undefined

  initializationPromise = manager
    .initialize(serversOverride)
    .then(() => {
      if (generation !== initializationGeneration) {
        void manager.shutdown()
        return
      }
      registerLspNotificationHandlers(manager)
      initializationState = 'success'
    })
    .catch(err => {
      if (generation !== initializationGeneration) {
        return
      }
      initializationState = 'failed'
      initializationError = err instanceof Error ? err : new Error(String(err))
    })

  return initializationPromise
}

/**
 * Returns the active `LSPServerManager` instance if initialized.
 */
export function getLspServerManager(): LSPServerManager | null {
  return lspManagerInstance
}

/**
 * Returns the current initialization status and optional error.
 */
export function getInitializationStatus(): {
  status: LspInitializationState
  error?: Error
} {
  return {
    status: initializationState,
    ...(initializationError ? { error: initializationError } : {}),
  }
}

/**
 * Awaits any in-flight `initializeLspServerManager()` call.
 */
export async function waitForInitialization(): Promise<void> {
  if (initializationPromise) {
    await initializationPromise
  }
}

/**
 * Returns true if at least one non-errored LSP server is registered.
 */
export function isLspConnected(): boolean {
  if (!lspManagerInstance || lspManagerInstance.servers.size === 0) {
    return false
  }
  for (const srv of lspManagerInstance.servers.values()) {
    if (srv.state !== 'error') {
      return true
    }
  }
  return false
}

/**
 * Shuts down existing LSP servers and re-initializes from current plugin configs.
 */
export async function reinitializeLspServerManager(
  serversOverride?: Record<string, ScopedLspServerConfig>,
): Promise<void> {
  await shutdownLspServerManager()
  await initializeLspServerManager(serversOverride)
}

/**
 * Shuts down all running LSP servers and resets singleton state.
 */
export async function shutdownLspServerManager(): Promise<void> {
  initializationGeneration++
  const current = lspManagerInstance
  lspManagerInstance = null
  initializationState = 'not-started'
  initializationError = undefined
  initializationPromise = null
  if (current) {
    await current.shutdown()
  }
}

/**
 * Test helper resetting the singleton LSP manager synchronously/asynchronously.
 */
export async function resetLspManagerForTesting(): Promise<void> {
  await shutdownLspServerManager()
}

registerCleanup(async () => {
  await shutdownLspServerManager()
})

registerPluginLspReinitializer(async () => {
  await reinitializeLspServerManager()
})
