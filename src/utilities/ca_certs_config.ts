import { getGlobalConfig } from './config.js'
import { logError } from './log.js'
import { getSettingsForSource } from './settings/settings.js'

/**
 * Applies `NODE_EXTRA_CA_CERTS` from user-controlled settings or global config
 * before the first TLS handshake (pre-trust safe; never reads project settings).
 */
export function applyExtraCaCertsFromConfig(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) {
    return
  }

  try {
    const configPath =
      getSettingsForSource('userSettings')?.env?.NODE_EXTRA_CA_CERTS ||
      getGlobalConfig()?.env?.NODE_EXTRA_CA_CERTS
    if (configPath) {
      process.env.NODE_EXTRA_CA_CERTS = configPath
    }
  } catch (error) {
    logError(error)
  }
}
