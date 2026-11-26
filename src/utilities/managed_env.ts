import { clearCaCertsCache } from './ca_certs.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './env_utils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managed_env_constants.js'
import { clearMtlsCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from './settings/settings.js'

let remoteEligibilityHook: (() => void) | undefined

export function registerRemoteManagedSettingsEligibilityHook(
  hook: () => void,
): void {
  remoteEligibilityHook = hook
}

function withoutSshTunnelVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !process.env.ANTHROPIC_UNIX_SOCKET) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (
      key === 'ANTHROPIC_UNIX_SOCKET' ||
      key === 'ANTHROPIC_BASE_URL' ||
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key === 'COPILOT_CLI_OAUTH_TOKEN'
    ) {
      continue
    }
    out[key] = value
  }
  return out
}

function withoutHostManagedProviderVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}
  if (!isEnvTruthy(process.env.COPILOT_CLI_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

let ccdSpawnEnvKeys: Set<string> | null | undefined

function withoutCcdSpawnEnvKeys(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!ccdSpawnEnvKeys.has(key)) out[key] = value
  }
  return out
}

function filterSettingsEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(withoutSshTunnelVars(env)),
  )
}

const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * Applies environment variables from trusted sources before the trust dialog,
 * plus SAFE_ENV_VARS allowlisted variables from project/local settings.
 */
export function applySafeConfigEnvironmentVariables(): void {
  if (ccdSpawnEnvKeys === undefined) {
    ccdSpawnEnvKeys =
      process.env.COPILOT_CLI_ENTRYPOINT === 'claude-desktop'
        ? new Set(Object.keys(process.env))
        : null
  }

  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  for (const source of TRUSTED_SETTING_SOURCES) {
    if (source === 'policySettings') continue
    if (!isSettingSourceEnabled(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env),
    )
  }

  remoteEligibilityHook?.()

  Object.assign(
    process.env,
    filterSettingsEnv(getSettingsForSource('policySettings')?.env),
  )

  const settingsEnv = filterSettingsEnv(getInitialSettings()?.env)
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }
}

/**
 * Applies all environment variables from global config and merged settings
 * after workspace trust is established, then clears and reconfigures TLS/proxy caches.
 */
export function applyConfigEnvironmentVariables(): void {
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))
  Object.assign(process.env, filterSettingsEnv(getInitialSettings()?.env))

  clearCaCertsCache()
  clearMtlsCache()
  clearProxyCache()
  configureGlobalAgents()
}

export function resetManagedEnvStateForTesting(): void {
  ccdSpawnEnvKeys = undefined
}
