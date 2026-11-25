/**
 * Local-default feature-flag facade (GrowthBook interface).
 *
 * Phase 1 uses a zero-network local facade returning defaults plus optional
 * in-memory / env overrides so startup and tests have no external GrowthBook
 * SDK dependency. Remote evaluation can be attached in a later phase.
 */

import type { GitHubActionsMetadata } from '../../types/forward.js'
import { logError } from '../../utils/log.js'
import { createSignal } from '../../utils/signal.js'

export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceId: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUuid?: string
  accountUuid?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

type GrowthBookRefreshListener = () => void | Promise<void>

const refreshed = createSignal()
const localFeatureValues = new Map<string, unknown>()
let envOverrides: Record<string, unknown> | null = null
let envOverridesParsed = false

function callSafe(listener: GrowthBookRefreshListener): void {
  try {
    void Promise.resolve(listener()).catch(error => {
      logError(error)
    })
  } catch (error) {
    logError(error)
  }
}

function getEnvOverrides(): Record<string, unknown> | null {
  if (!envOverridesParsed) {
    envOverridesParsed = true
    const raw = process.env.COPILOT_FEATURE_OVERRIDES
    if (raw) {
      try {
        envOverrides = JSON.parse(raw) as Record<string, unknown>
      } catch {
        logError(new Error(`Failed to parse COPILOT_FEATURE_OVERRIDES: ${raw}`))
      }
    }
  }
  return envOverrides
}

export function onGrowthBookRefresh(
  listener: GrowthBookRefreshListener,
): () => void {
  let subscribed = true
  const unsubscribe = refreshed.subscribe(() => callSafe(listener))
  if (localFeatureValues.size > 0) {
    queueMicrotask(() => {
      if (subscribed && localFeatureValues.size > 0) {
        callSafe(listener)
      }
    })
  }
  return () => {
    subscribed = false
    unsubscribe()
  }
}

export function hasGrowthBookEnvOverride(featureName: string): boolean {
  const overrides = getEnvOverrides()
  return overrides !== null && featureName in overrides
}

export function getAllGrowthBookFeatures(): Record<string, unknown> {
  return Object.fromEntries(localFeatureValues)
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return Object.fromEntries(localFeatureValues)
}

export function setGrowthBookConfigOverride(
  featureName: string,
  value: unknown,
): void {
  if (value === undefined) {
    localFeatureValues.delete(featureName)
  } else {
    localFeatureValues.set(featureName, value)
  }
  refreshed.emit()
}

export function clearGrowthBookConfigOverrides(): void {
  localFeatureValues.clear()
  refreshed.emit()
}

export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).host
    if (host === 'api.anthropic.com') return undefined
    return host
  } catch {
    return undefined
  }
}

export async function initializeGrowthBook(): Promise<null> {
  return null
}

export function getFeatureValueCachedMayBeStale<Value>(
  featureName: string,
  defaultValue: Value,
): Value {
  const overrides = getEnvOverrides()
  if (overrides && featureName in overrides) {
    return overrides[featureName] as Value
  }
  if (localFeatureValues.has(featureName)) {
    return localFeatureValues.get(featureName) as Value
  }
  return defaultValue
}

export async function getFeatureValueDeprecated<Value>(
  featureName: string,
  defaultValue: Value,
): Promise<Value> {
  return getFeatureValueCachedMayBeStale(featureName, defaultValue)
}

export function getFeatureValueCachedWithRefresh<Value>(
  featureName: string,
  defaultValue: Value,
  _refreshIntervalMs: number,
): Value {
  return getFeatureValueCachedMayBeStale(featureName, defaultValue)
}

export function checkStatsigFeatureGateCachedMayBeStale(
  gateName: string,
): boolean {
  return Boolean(getFeatureValueCachedMayBeStale(gateName, false))
}

export async function checkSecurityRestrictionGate(
  gateName: string,
): Promise<boolean> {
  return Boolean(getFeatureValueCachedMayBeStale(gateName, false))
}

export async function checkGateCachedOrBlocking(
  gateName: string,
): Promise<boolean> {
  return Boolean(getFeatureValueCachedMayBeStale(gateName, false))
}

export function refreshGrowthBookAfterAuthChange(): void {
  refreshed.emit()
}

export async function refreshGrowthBookFeatures(): Promise<void> {
  // No-op in local-default Phase 1 facade
}

export function setupPeriodicGrowthBookRefresh(): void {
  // No-op in local-default Phase 1 facade
}

export function stopPeriodicGrowthBookRefresh(): void {
  // No-op in local-default Phase 1 facade
}

export function resetGrowthBook(): void {
  localFeatureValues.clear()
  envOverrides = null
  envOverridesParsed = false
}

export async function getDynamicConfigBlocksOnInit<Value>(
  configName: string,
  defaultValue: Value,
): Promise<Value> {
  return getFeatureValueCachedMayBeStale(configName, defaultValue)
}

export function getDynamicConfigCachedMayBeStale<Value>(
  configName: string,
  defaultValue: Value,
): Value {
  return getFeatureValueCachedMayBeStale(configName, defaultValue)
}
