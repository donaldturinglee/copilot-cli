/**
 * GrowthBook configuration for Tier 2a time-based microcompact.
 */

import { getFeatureValueCachedMayBeStale } from '../analytics/growthbook.js'

export interface TimeBasedMicrocompactConfig {
  enabled: boolean
  gapThresholdMinutes: number
  keepRecent: number
}

export const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMicrocompactConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}

let testOverrideConfig: Partial<TimeBasedMicrocompactConfig> | null = null

/**
 * Sets a test-only override for time-based microcompact configuration.
 */
export function setTimeBasedMcConfigForTesting(
  override: Partial<TimeBasedMicrocompactConfig> | null,
): void {
  testOverrideConfig = override
}

/**
 * Returns the active time-based microcompact configuration from GrowthBook
 * (`tengu_slate_heron`) merged over safe defaults (60m idle gap, keep 5).
 */
export function getTimeBasedMcConfig(): TimeBasedMicrocompactConfig {
  const remote = getFeatureValueCachedMayBeStale<
    Partial<TimeBasedMicrocompactConfig>
  >('tengu_slate_heron', {})

  const merged: TimeBasedMicrocompactConfig = {
    enabled:
      typeof remote.enabled === 'boolean'
        ? remote.enabled
        : TIME_BASED_MC_CONFIG_DEFAULTS.enabled,
    gapThresholdMinutes:
      typeof remote.gapThresholdMinutes === 'number' &&
      Number.isFinite(remote.gapThresholdMinutes) &&
      remote.gapThresholdMinutes > 0
        ? remote.gapThresholdMinutes
        : TIME_BASED_MC_CONFIG_DEFAULTS.gapThresholdMinutes,
    keepRecent:
      typeof remote.keepRecent === 'number' &&
      Number.isFinite(remote.keepRecent) &&
      remote.keepRecent >= 1
        ? Math.floor(remote.keepRecent)
        : TIME_BASED_MC_CONFIG_DEFAULTS.keepRecent,
  }

  if (testOverrideConfig) {
    return {
      ...merged,
      ...testOverrideConfig,
    }
  }

  return merged
}
