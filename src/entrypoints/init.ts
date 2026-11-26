import memoize from 'lodash-es/memoize.js'
import {
  getIsNonInteractiveSession,
  getSessionCounter,
} from '../bootstrap/state.js'
import { preconnectAnthropicApi } from '../utilities/api_preconnect.js'
import { applyExtraCaCertsFromConfig } from '../utilities/ca_certs_config.js'
import { enableConfigs, recordFirstStartTime } from '../utilities/config.js'
import { detectCurrentRepository } from '../utilities/detect_repository.js'
import { logForDiagnosticsNoPii } from '../utilities/diag_logs.js'
import { initJetBrainsDetection } from '../utilities/env_dynamic.js'
import { ConfigParseError } from '../utilities/errors.js'
import {
  gracefulShutdownSync,
  setupGracefulShutdown,
} from '../utilities/graceful_shutdown.js'
import { applySafeConfigEnvironmentVariables } from '../utilities/managed_env.js'
import { configureGlobalMtls } from '../utilities/mtls.js'
import { configureGlobalAgents } from '../utilities/proxy.js'
import { startKeychainPrefetch } from '../utilities/secure_storage/keychain_prefetch.js'
import { profileCheckpoint } from '../utilities/startup_profiler.js'
import { setShellIfWindows } from '../utilities/windows_paths.js'

export type InitHooks = {
  onPostInitAsync?: () => void
  onTelemetryInitialize?: () => Promise<void> | void
  onInvalidConfigInteractive?: (error: ConfigParseError) => Promise<void>
}

let initHooks: InitHooks = {}
let telemetryInitialized = false

/**
 * Registers downstream Phase 2+/5+ initialization callbacks without
 * introducing backward imports in Phase 1.
 */
export function registerInitHooks(hooks: Partial<InitHooks>): void {
  initHooks = { ...initHooks, ...hooks }
}

export function resetInitStateForTesting(): void {
  init.cache.clear?.()
  telemetryInitialized = false
}

export const init = memoize(async (): Promise<void> => {
  const startTime = Date.now()
  logForDiagnosticsNoPii('info', 'init_started')
  profileCheckpoint('init_function_start')

  try {
    enableConfigs()
    profileCheckpoint('init_configs_enabled')

    applySafeConfigEnvironmentVariables()
    applyExtraCaCertsFromConfig()
    profileCheckpoint('init_safe_env_vars_applied')

    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    void initJetBrainsDetection()
    void detectCurrentRepository()
    startKeychainPrefetch()
    initHooks.onPostInitAsync?.()

    recordFirstStartTime()

    configureGlobalMtls()
    configureGlobalAgents()
    profileCheckpoint('init_network_configured')

    preconnectAnthropicApi()
    setShellIfWindows()

    logForDiagnosticsNoPii('info', 'init_completed', {
      duration_ms: Date.now() - startTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      if (getIsNonInteractiveSession() || !initHooks.onInvalidConfigInteractive) {
        process.stderr.write(
          `Configuration error in ${error.filePath}: ${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }
      await initHooks.onInvalidConfigInteractive(error)
      return
    }
    throw error
  }
})

/**
 * Initializes OpenTelemetry metrics/logging after workspace trust is established.
 * Idempotent: guarded against double initialization; resets on failure.
 */
export function initializeTelemetryAfterTrust(): void {
  if (telemetryInitialized) {
    return
  }
  telemetryInitialized = true
  try {
    const maybePromise = initHooks.onTelemetryInitialize?.()
    if (maybePromise instanceof Promise) {
      void maybePromise
        .then(() => {
          getSessionCounter()?.add(1)
        })
        .catch(() => {
          telemetryInitialized = false
        })
    } else {
      getSessionCounter()?.add(1)
    }
  } catch {
    telemetryInitialized = false
  }
}
