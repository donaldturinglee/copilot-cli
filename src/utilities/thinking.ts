/**
 * Extended thinking configuration (`adaptive` / `enabled` / `disabled`),
 * ultrathink keyword triggers, and model thinking capability checks.
 */

import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import { registerDefaultAppStateHooks } from '../state/app_state_store.js'
import { isFeatureEnabled } from './feature_flags.js'
import { resolveAntModel } from './model/ant_models.js'
import { getCanonicalName } from './model/model.js'
import { get3pModelCapabilityOverride } from './model/model_support_overrides.js'
import { getApiProvider } from './model/providers.js'
import { getInitialSettings } from './settings/settings.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

const RAINBOW_COLORS = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
] as const

const RAINBOW_SHIMMER_COLORS = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
] as const

/**
 * Returns true if the `ultrathink` keyword trigger feature is enabled.
 */
export function isUltrathinkEnabled(): boolean {
  return (
    isFeatureEnabled('ULTRATHINK') &&
    getFeatureValueCachedMayBeStale('tengu_turtle_carbon', true)
  )
}

/**
 * Returns true if `text` contains the word `ultrathink` (case-insensitive).
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Finds all start/end spans of `ultrathink` keyword occurrences in `text`.
 */
export function findThinkingTriggerPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const regex = /\bultrathink\b/gi
  const positions: Array<{ start: number; end: number }> = []
  let match = regex.exec(text)
  while (match !== null) {
    positions.push({ start: match.index, end: match.index + match[0].length })
    match = regex.exec(text)
  }
  return positions
}

/**
 * Returns the rainbow theme color token for a character index.
 */
export function getRainbowColor(charIndex: number, shimmer = false): string {
  const palette = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  const normalized =
    ((charIndex % palette.length) + palette.length) % palette.length
  return palette[normalized]!
}

/**
 * Returns true if `model` supports extended thinking.
 */
export function modelSupportsThinking(model: string): boolean {
  const override = get3pModelCapabilityOverride(model, 'thinking')
  if (override !== undefined) {
    return override
  }
  if (resolveAntModel(model)) {
    return true
  }
  const provider = getApiProvider()
  const canonical = getCanonicalName(model)
  if (provider === 'firstParty' || provider === 'foundry') {
    return !canonical.includes('claude-3-')
  }
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

/**
 * Returns true if `model` supports adaptive thinking (`{ type: 'adaptive' }`).
 */
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const override = get3pModelCapabilityOverride(model, 'adaptive_thinking')
  if (override !== undefined) {
    return override
  }
  const canonical = getCanonicalName(model)
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
    return true
  }
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  const provider = getApiProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

/**
 * Resolves whether thinking should be enabled by default based on
 * `MAX_THINKING_TOKENS` and `settings.alwaysThinkingEnabled`.
 */
export function shouldEnableThinkingByDefault(): boolean {
  const rawMaxThinking = process.env.MAX_THINKING_TOKENS
  if (rawMaxThinking !== undefined) {
    const parsed = Number(rawMaxThinking)
    return !Number.isNaN(parsed) && parsed > 0
  }
  return getInitialSettings().alwaysThinkingEnabled !== false
}

registerDefaultAppStateHooks({
  shouldEnableThinkingByDefault,
})
