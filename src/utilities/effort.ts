/**
 * Effort parameter (`low` | `medium` | `high` | `max` | numeric) resolution,
 * model capability gating, and persistence rules.
 */

import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import type { EffortLevel, EffortValue } from '../types/forward.js'
import {
  isMaxSubscriber,
  isProSubscriber,
  isTeamSubscriber,
} from './auth.js'
import { isEnvTruthy } from './env_utils.js'
import { resolveAntModel } from './model/ant_models.js'
import { getCanonicalName } from './model/model.js'
import { get3pModelCapabilityOverride } from './model/model_support_overrides.js'
import { getApiProvider } from './model/providers.js'
import { getInitialSettings } from './settings/settings.js'
import { isUltrathinkEnabled } from './thinking.js'

export type { EffortLevel, EffortValue }

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

/**
 * Returns true if `value` is a valid positive integer numeric effort (ant-only).
 */
export function isValidNumericEffort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Parses a raw string or number into an `EffortValue`, or `undefined` if invalid.
 */
export function parseEffortValue(
  raw: string | number | undefined,
): EffortValue | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw === 'number') {
    return isValidNumericEffort(raw) ? raw : undefined
  }
  const normalized = raw.trim().toLowerCase()
  if ((EFFORT_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as EffortLevel
  }
  if (process.env.USER_TYPE === 'ant' && /^\d+$/.test(normalized)) {
    const num = Number(normalized)
    return isValidNumericEffort(num) ? num : undefined
  }
  return undefined
}

/**
 * Returns true if `model` supports the `output_config.effort` API parameter.
 */
export function modelSupportsEffort(model: string): boolean {
  if (isEnvTruthy(process.env.COPILOT_CLI_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const override = get3pModelCapabilityOverride(model, 'effort')
  if (override !== undefined) {
    return override
  }
  const canonical = getCanonicalName(model)
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
    return true
  }
  if (
    canonical.includes('haiku') ||
    canonical.includes('sonnet') ||
    canonical.includes('opus')
  ) {
    return false
  }
  return getApiProvider() === 'firstParty'
}

/**
 * Returns true if `model` supports the `max` effort tier.
 */
export function modelSupportsMaxEffort(model: string): boolean {
  const override = get3pModelCapabilityOverride(model, 'max_effort')
  if (override !== undefined) {
    return override
  }
  const canonical = getCanonicalName(model)
  if (canonical.includes('opus-4-6')) {
    return true
  }
  return Boolean(resolveAntModel(model)?.supportsMaxEffort)
}

/**
 * Reads `COPILOT_CLI_EFFORT_LEVEL`.
 * Returns `null` when explicitly set to `'unset'` or `'auto'` (suppresses param),
 * an `EffortValue` when valid, or `undefined` when unset.
 */
export function getEffortEnvOverride(): EffortValue | null | undefined {
  const raw = process.env.COPILOT_CLI_EFFORT_LEVEL
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const lower = raw.trim().toLowerCase()
  if (lower === 'unset' || lower === 'auto') {
    return null
  }
  return parseEffortValue(lower)
}

/**
 * Reads the GrowthBook default-effort configuration for Opus 4.6.
 */
export function getOpusDefaultEffortConfig(): { enabled: boolean } {
  return getFeatureValueCachedMayBeStale<{ enabled: boolean }>(
    'tengu_grey_step2',
    { enabled: true },
  )
}

/**
 * Computes the default effort level for a model when neither env nor user state sets one.
 */
export function getDefaultEffortForModel(
  model: string,
): EffortLevel | undefined {
  const canonical = getCanonicalName(model)
  if (canonical.includes('opus-4-6')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      (isMaxSubscriber() || isTeamSubscriber()) &&
      getOpusDefaultEffortConfig().enabled
    ) {
      return 'medium'
    }
  }
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }
  return undefined
}

/**
 * Resolves the effective effort value to send on an API request, clamping
 * `'max'` down to `'high'` if the model does not support max effort.
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue?: EffortValue,
): EffortValue | undefined {
  if (!modelSupportsEffort(model)) {
    return undefined
  }
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * Returns the initial effort level from settings.
 */
export function getInitialEffortSetting(): EffortLevel | undefined {
  const configured = getInitialSettings().effortLevel
  if (!configured) {
    return undefined
  }
  const parsed = parseEffortValue(configured)
  return typeof parsed === 'string' ? parsed : undefined
}

/**
 * Maps an effort value to a persistable settings value (`low`/`medium`/`high`,
 * plus `max` for ant builds; numeric & external `max` stay session-ephemeral).
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (value === undefined || typeof value === 'number') {
    return undefined
  }
  if (value === 'max' && process.env.USER_TYPE !== 'ant') {
    return undefined
  }
  return value
}

/**
 * Resolves whether picker selection should persist to settings.
 */
export function resolvePickerEffortPersistence(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  return toPersistableEffort(value)
}

/**
 * Converts numeric effort overrides into their closest named effort tier.
 */
export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    return value
  }
  if (value <= 50) return 'low'
  if (value <= 85) return 'medium'
  if (value <= 100) return 'high'
  return 'max'
}

/**
 * Returns the effort tier displayed in status chrome for a model.
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffortValue?: EffortValue,
): EffortLevel | undefined {
  const resolved = resolveAppliedEffort(model, appStateEffortValue)
  if (resolved === undefined) {
    return undefined
  }
  return convertEffortValueToLevel(resolved)
}

/**
 * Formats a compact effort suffix for model display labels.
 */
export function getEffortSuffix(effort?: EffortValue): string {
  if (effort === undefined) {
    return ''
  }
  return ` (${effort} effort)`
}

/**
 * Returns a human-readable description for a named effort level.
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Fastest responses with minimal reasoning'
    case 'medium':
      return 'Balanced speed and reasoning depth'
    case 'high':
      return 'Thorough reasoning for complex tasks'
    case 'max':
      return 'Maximum reasoning depth (Opus 4.6)'
    default:
      return ''
  }
}

/**
 * Returns a human-readable description for any effort value.
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (typeof value === 'number') {
    return `Custom numeric effort (${value})`
  }
  return getEffortLevelDescription(value)
}
