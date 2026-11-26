/**
 * Fast mode (`speed: 'fast'`) eligibility, org prefetch, runtime cooldown
 * management, and API rejection handling.
 */

import axios from 'axios'
import { getKairosActive } from '../bootstrap/state.js'
import { getOauthConfig } from '../constants/oauth.js'
import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { isEnvTruthy } from './env_utils.js'
import { getAuthHeaders, withOauth401Retry } from './http.js'
import {
  getDefaultMainLoopModel,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
} from './model/model.js'
import { getApiProvider } from './model/providers.js'
import { isEssentialTrafficOnly } from './privacy_level.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'
import { createSignal } from './signal.js'

export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.6'

export type FastModeCooldownReason = 'rate_limit' | 'overloaded'

export type FastModeRuntimeState =
  | { status: 'active' }
  | { status: 'cooldown'; resetAt: number; reason: FastModeCooldownReason }

export type FastModeOrgStatus =
  | 'enabled'
  | 'disabled'
  | 'network_error'
  | 'unknown'

export type FastModeState = 'on' | 'cooldown' | 'off'

const ORG_PREFETCH_THROTTLE_MS = 30_000
const ORG_PREFETCH_TIMEOUT_MS = 5_000

let runtimeState: FastModeRuntimeState = { status: 'active' }
let orgStatus: FastModeOrgStatus = 'unknown'
let lastOrgPrefetchAt = 0
let inflightOrgPrefetch: Promise<FastModeOrgStatus> | null = null

const cooldownTriggeredSignal = createSignal<
  [resetAt: number, reason: FastModeCooldownReason]
>()
const cooldownExpiredSignal = createSignal()
const overageRejectionSignal = createSignal<[reason: string]>()

export const onFastModeCooldownTriggered = cooldownTriggeredSignal.subscribe
export const onFastModeCooldownExpired = cooldownExpiredSignal.subscribe
export const onFastModeOverageRejection = overageRejectionSignal.subscribe

/**
 * Returns true if fast mode is not disabled via environment variable.
 */
export function isFastModeEnabled(): boolean {
  return !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_FAST_MODE)
}

/**
 * Returns the model alias backing fast mode (`opus` or `opus[1m]`).
 */
export function getFastModeModel(): string {
  return `opus${isOpus1mMergeEnabled() ? '[1m]' : ''}`
}

/**
 * Returns true if `modelSetting` resolves to an Opus 4.6 model supporting fast mode.
 */
export function isFastModeSupportedByModel(
  modelSetting?: string | null,
): boolean {
  const resolved = parseUserSpecifiedModel(
    modelSetting ?? getDefaultMainLoopModel(),
  )
  return resolved.toLowerCase().includes('opus-4-6')
}

/**
 * Returns the active runtime state, automatically transitioning from `cooldown`
 * back to `active` once `resetAt` has elapsed.
 */
export function getFastModeRuntimeState(): FastModeRuntimeState {
  if (
    runtimeState.status === 'cooldown' &&
    Date.now() >= runtimeState.resetAt
  ) {
    runtimeState = { status: 'active' }
    cooldownExpiredSignal.emit()
  }
  return runtimeState
}

/**
 * Returns true if fast mode is currently in a temporary cooldown window.
 */
export function isFastModeCooldown(): boolean {
  return getFastModeRuntimeState().status === 'cooldown'
}

/**
 * Enters fast-mode cooldown until `resetAt` epoch milliseconds.
 */
export function triggerFastModeCooldown(
  resetAt: number,
  reason: FastModeCooldownReason,
): void {
  runtimeState = { status: 'cooldown', resetAt, reason }
  cooldownTriggeredSignal.emit(resetAt, reason)
}

/**
 * Returns an unavailability reason string if fast mode cannot be used, or `null`.
 */
export function getFastModeUnavailableReason(): string | null {
  if (!isFastModeEnabled()) {
    return 'Fast mode is disabled via COPILOT_CLI_DISABLE_FAST_MODE.'
  }
  if (getFeatureValueCachedMayBeStale('tengu_penguins_off', false)) {
    return 'Fast mode is temporarily unavailable.'
  }
  if (getFeatureValueCachedMayBeStale('tengu_marble_sandcastle', false)) {
    return 'Fast mode is unavailable for this build.'
  }
  if (
    process.env.CLAUDE_AGENT_SDK_VERSION &&
    !getKairosActive() &&
    !getSettingsForSource('flagSettings')?.fastMode
  ) {
    return 'Fast mode requires explicit flagSettings.fastMode under Agent SDK.'
  }
  if (getApiProvider() !== 'firstParty') {
    return 'Fast mode is only supported with Anthropic first-party API.'
  }
  const cachedOrgEnabled = getGlobalConfig().penguinModeOrgEnabled
  const effectiveOrgStatus: FastModeOrgStatus =
    orgStatus !== 'unknown'
      ? orgStatus
      : cachedOrgEnabled === false
        ? 'disabled'
        : cachedOrgEnabled === true
          ? 'enabled'
          : 'unknown'

  if (effectiveOrgStatus === 'disabled') {
    return 'Fast mode is not enabled for your organization.'
  }
  if (
    (effectiveOrgStatus === 'network_error' ||
      effectiveOrgStatus === 'unknown') &&
    isEnvTruthy(process.env.COPILOT_CLI_SKIP_FAST_MODE_NETWORK_ERRORS)
  ) {
    return null
  }
  return null
}

/**
 * Returns true if fast mode is currently available for requests.
 */
export function isFastModeAvailable(): boolean {
  return getFastModeUnavailableReason() === null
}

/**
 * Computes the UI/SDK fast-mode state (`'on' | 'cooldown' | 'off'`).
 */
export function getFastModeState(
  model: string | null | undefined,
  userEnabled: boolean | undefined,
): FastModeState {
  if (!userEnabled || !isFastModeAvailable() || !isFastModeSupportedByModel(model)) {
    return 'off'
  }
  return isFastModeCooldown() ? 'cooldown' : 'on'
}

/**
 * Permanently disables fast mode after an API 400 "Fast mode is not enabled" error.
 */
export function handleFastModeRejectedByApi(): void {
  orgStatus = 'disabled'
  saveGlobalConfig(current => ({
    ...current,
    penguinModeOrgEnabled: false,
  }))
  updateSettingsForSource('userSettings', { fastMode: undefined })
}

/**
 * Handles a 429 overage disabled reason during fast mode; disables permanently
 * except for transient `'out_of_credits'` or `'org_level_disabled_until'`.
 */
export function handleFastModeOverageRejection(reason: string): void {
  if (reason !== 'out_of_credits' && reason !== 'org_level_disabled_until') {
    handleFastModeRejectedByApi()
  }
  overageRejectionSignal.emit(reason)
}

/**
 * Prefetches organization-level fast-mode availability (throttled to 30s,
 * deduplicated across concurrent callers, retries 401/revoked-403 via OAuth).
 */
export async function prefetchFastModeOrgStatus(): Promise<FastModeOrgStatus> {
  if (
    !isFastModeEnabled() ||
    isEssentialTrafficOnly() ||
    getApiProvider() !== 'firstParty'
  ) {
    return orgStatus
  }
  const now = Date.now()
  if (now - lastOrgPrefetchAt < ORG_PREFETCH_THROTTLE_MS && orgStatus !== 'unknown') {
    return orgStatus
  }
  if (inflightOrgPrefetch) {
    return inflightOrgPrefetch
  }

  const promise = (async (): Promise<FastModeOrgStatus> => {
    lastOrgPrefetchAt = Date.now()
    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      return orgStatus
    }
    try {
      const response = await withOauth401Retry(
        () =>
          axios.get<{ enabled?: boolean }>(
            `${getOauthConfig().BASE_API_URL}/api/claude_code_penguin_mode`,
            {
              headers: getAuthHeaders().headers,
              timeout: ORG_PREFETCH_TIMEOUT_MS,
            },
          ),
        { also403Revoked: true },
      )
      const enabled = Boolean(response.data?.enabled)
      orgStatus = enabled ? 'enabled' : 'disabled'
      saveGlobalConfig(current => ({
        ...current,
        penguinModeOrgEnabled: enabled,
      }))
      if (!enabled) {
        updateSettingsForSource('userSettings', { fastMode: undefined })
      }
      return orgStatus
    } catch {
      orgStatus = 'network_error'
      return orgStatus
    } finally {
      inflightOrgPrefetch = null
    }
  })()

  inflightOrgPrefetch = promise
  return promise
}

/**
 * Resets fast mode runtime/org state for deterministic unit tests.
 */
export function resetFastModeStateForTesting(): void {
  runtimeState = { status: 'active' }
  orgStatus = 'unknown'
  lastOrgPrefetchAt = 0
  inflightOrgPrefetch = null
}
