/**
 * Leaf configuration module for background memory consolidation (`autoDream`).
 */

import { getInitialSettings } from '../../utilities/settings/settings.js'
import { getFeatureValueCachedMayBeStale } from '../analytics/growthbook.js'

export interface AutoDreamRemoteConfig {
  enabled?: boolean
  minHours?: number
  minSessions?: number
}

export const AUTO_DREAM_DEFAULTS = {
  minHours: 24,
  minSessions: 5,
} as const

/**
 * Returns whether automatic background memory consolidation (`autoDream`) is
 * enabled via user/project settings or GrowthBook (`tengu_onyx_plover`).
 */
export function isAutoDreamEnabled(): boolean {
  const setting = getInitialSettings().autoDreamEnabled
  if (setting !== undefined) {
    return setting
  }
  const remote = getFeatureValueCachedMayBeStale<AutoDreamRemoteConfig>(
    'tengu_onyx_plover',
    {},
  )
  return remote.enabled === true
}

/**
 * Returns active time and session-count thresholds for `autoDream`.
 */
export function getAutoDreamThresholds(): {
  minHours: number
  minSessions: number
} {
  const remote = getFeatureValueCachedMayBeStale<AutoDreamRemoteConfig>(
    'tengu_onyx_plover',
    {},
  )
  return {
    minHours:
      typeof remote.minHours === 'number' && remote.minHours > 0
        ? remote.minHours
        : AUTO_DREAM_DEFAULTS.minHours,
    minSessions:
      typeof remote.minSessions === 'number' && remote.minSessions > 0
        ? Math.floor(remote.minSessions)
        : AUTO_DREAM_DEFAULTS.minSessions,
  }
}
