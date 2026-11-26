/**
 * Model alias resolution, canonical naming, default model selection,
 * `opusplan` runtime switching, and human-readable display formatting.
 */

import {
  getMainLoopModelOverride,
  setInitialMainLoopModel,
} from '../../bootstrap/state.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  getSubscriptionType,
  isClaudeAiSubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1m,
} from '../context.js'
import { isEnvTruthy } from '../env_utils.js'
import { getInitialSettings } from '../settings/settings.js'
import { getAntModelOverrideConfig, resolveAntModel } from './ant_models.js'
import { isModelAllowed } from './model_allowlist.js'
import { getModelStrings, resolveOverriddenModel } from './model_strings.js'
import { getApiProvider } from './providers.js'

export type ModelShortName = string

const LEGACY_1P_OPUS_IDS = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
])

/**
 * Strips `[1m]` / `[2m]` context suffix tags before sending a model ID to the API.
 */
export function normalizeModelStringForApi(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}

/**
 * Maps a first-party model ID or alias to its canonical short name.
 * Pure and safe at module top level; version order matters (`4-6` before `4`).
 */
export function firstPartyNameToCanonical(name: string): ModelShortName {
  const lower = normalizeModelStringForApi(name).toLowerCase()
  if (lower.includes('opus-4-6')) return 'claude-opus-4-6'
  if (lower.includes('opus-4-5')) return 'claude-opus-4-5'
  if (lower.includes('opus-4-1')) return 'claude-opus-4-1'
  if (lower.includes('opus-4')) return 'claude-opus-4'
  if (lower.includes('sonnet-4-6')) return 'claude-sonnet-4-6'
  if (lower.includes('sonnet-4-5')) return 'claude-sonnet-4-5'
  if (lower.includes('sonnet-4')) return 'claude-sonnet-4'
  if (lower.includes('3-7-sonnet')) return 'claude-3-7-sonnet'
  if (lower.includes('3-5-sonnet')) return 'claude-3-5-sonnet'
  if (lower.includes('haiku-4-5')) return 'claude-haiku-4-5'
  if (lower.includes('3-5-haiku')) return 'claude-3-5-haiku'
  if (lower.includes('3-opus')) return 'claude-3-opus'
  if (lower.includes('3-sonnet')) return 'claude-3-sonnet'
  if (lower.includes('3-haiku')) return 'claude-3-haiku'
  return lower
}

/**
 * Resolves any provider/overridden model string to its canonical short name.
 */
export function getCanonicalName(fullModelName: string): ModelShortName {
  const unoverridden = resolveOverriddenModel(fullModelName)
  return firstPartyNameToCanonical(unoverridden)
}

/**
 * Returns the default Opus model ID for the active provider.
 */
export function getDefaultOpusModel(): string {
  return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || getModelStrings().opus46
}

/**
 * Returns the default Sonnet model ID for the active provider.
 */
export function getDefaultSonnetModel(): string {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  const strings = getModelStrings()
  return getApiProvider() === 'firstParty' ? strings.sonnet46 : strings.sonnet45
}

/**
 * Returns the default Haiku model ID for the active provider.
 */
export function getDefaultHaikuModel(): string {
  return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || getModelStrings().haiku45
}

/**
 * Returns the small/fast model ID (used for lightweight auxiliary calls).
 */
export function getSmallFastModel(): string {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

/**
 * Returns the highest-capability model ID (`best` alias target).
 */
export function getBestModel(): string {
  return getDefaultOpusModel()
}

/**
 * Returns true if Opus 1M context is automatically merged for eligible 1P plans.
 */
export function isOpus1mMergeEnabled(): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (isProSubscriber()) {
    return false
  }
  if (getApiProvider() !== 'firstParty') {
    return false
  }
  if (isClaudeAiSubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

/**
 * Returns true if `model` targets a non-custom Opus model.
 */
export function isNonCustomOpusModel(model: string): boolean {
  const lower = normalizeModelStringForApi(model).toLowerCase()
  return lower === 'opus' || lower.includes('claude-opus-')
}

/**
 * Parses a user-supplied model string or alias (including `[1m]` suffixes and
 * `opusplan`) into a concrete provider model string.
 */
export function parseUserSpecifiedModel(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return getDefaultMainLoopModel()
  }

  const wants1m = has1mContext(trimmed)
  const withoutSuffix = trimmed.replace(/\[1m\]/gi, '').trim()
  const lower = withoutSuffix.toLowerCase()
  const suffix = wants1m ? '[1m]' : ''

  switch (lower) {
    case 'opusplan':
      return `${getDefaultSonnetModel()}${suffix}`
    case 'sonnet':
      return `${getDefaultSonnetModel()}${suffix}`
    case 'haiku':
      return `${getDefaultHaikuModel()}${suffix}`
    case 'opus':
      return `${getDefaultOpusModel()}${suffix}`
    case 'best':
      return `${getBestModel()}${suffix}`
    default:
      break
  }

  const antModel = resolveAntModel(withoutSuffix)
  if (antModel) {
    return `${antModel.id}${suffix}`
  }

  if (
    getApiProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_LEGACY_MODEL_REMAP) &&
    LEGACY_1P_OPUS_IDS.has(lower)
  ) {
    return `${getDefaultOpusModel()}${suffix}`
  }

  // Preserve original casing for custom/Foundry deployment IDs while normalizing [1m]
  return `${withoutSuffix}${suffix}`
}

/**
 * Returns the raw user-specified model setting from override > env > settings,
 * filtered through `isModelAllowed`.
 */
export function getUserSpecifiedModelSetting(): string | undefined {
  const override = getMainLoopModelOverride()
  const candidate =
    (override !== undefined && override !== null ? override : undefined) ??
    process.env.ANTHROPIC_MODEL ??
    getInitialSettings().model

  if (!candidate) {
    return undefined
  }
  if (!isModelAllowed(candidate)) {
    return undefined
  }
  return candidate
}

/**
 * Computes the default main-loop model setting based on account tier and provider.
 */
export function getDefaultMainLoopModelSetting(): string {
  if (process.env.USER_TYPE === 'ant') {
    const antDefault = getAntModelOverrideConfig()?.defaultModel
    if (antDefault) {
      return antDefault
    }
    return `${getDefaultOpusModel()}${is1mContextDisabled() ? '' : '[1m]'}`
  }

  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    return `${getDefaultOpusModel()}${isOpus1mMergeEnabled() ? '[1m]' : ''}`
  }

  return getDefaultSonnetModel()
}

/**
 * Resolves the default main-loop model ID.
 */
export function getDefaultMainLoopModel(): string {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

/**
 * Resolves the active main-loop model ID (respecting override, env, settings,
 * allowlist, and tier default).
 */
export function getMainLoopModel(): string {
  const userSetting = getUserSpecifiedModelSetting()
  const resolved = userSetting
    ? parseUserSpecifiedModel(userSetting)
    : getDefaultMainLoopModel()
  setInitialMainLoopModel(resolved)
  return resolved
}

/**
 * Resolves the per-turn runtime model, handling `opusplan` plan-mode switching
 * (uses Opus in plan mode while under 200k tokens, Sonnet otherwise) and `haiku`
 * plan-mode promotion to Sonnet.
 */
export function getRuntimeMainLoopModel({
  permissionMode,
  mainLoopModel,
  exceeds200kTokens = false,
}: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): string {
  const userSetting = getUserSpecifiedModelSetting()?.toLowerCase()
  const normalizedMain = mainLoopModel.trim().toLowerCase()
  if (userSetting === 'opusplan' || normalizedMain === 'opusplan') {
    if (permissionMode === 'plan' && !exceeds200kTokens) {
      return getDefaultOpusModel()
    }
    return normalizedMain === 'opusplan'
      ? getDefaultSonnetModel()
      : mainLoopModel
  }
  if (
    (userSetting === 'haiku' || normalizedMain === 'haiku') &&
    permissionMode === 'plan'
  ) {
    return getDefaultSonnetModel()
  }
  return mainLoopModel
}

/**
 * Resolves a skill's model override, inheriting `[1m]` from `currentModel` when
 * the target model supports 1M context.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  const parsed = parseUserSpecifiedModel(skillModel)
  if (
    has1mContext(currentModel) &&
    !has1mContext(parsed) &&
    modelSupports1m(parsed)
  ) {
    return `${parsed}[1m]`
  }
  return parsed
}

/**
 * Returns the public marketing name for a model (e.g. `"Claude Opus 4.6"`).
 */
export function getMarketingNameForModel(model: string): string {
  const canonical = getCanonicalName(model)
  switch (canonical) {
    case 'claude-opus-4-6':
      return 'Claude Opus 4.6'
    case 'claude-opus-4-5':
      return 'Claude Opus 4.5'
    case 'claude-opus-4-1':
      return 'Claude Opus 4.1'
    case 'claude-opus-4':
      return 'Claude Opus 4'
    case 'claude-sonnet-4-6':
      return 'Claude Sonnet 4.6'
    case 'claude-sonnet-4-5':
      return 'Claude Sonnet 4.5'
    case 'claude-sonnet-4':
      return 'Claude Sonnet 4'
    case 'claude-3-7-sonnet':
      return 'Claude 3.7 Sonnet'
    case 'claude-3-5-sonnet':
      return 'Claude 3.5 Sonnet'
    case 'claude-haiku-4-5':
      return 'Claude Haiku 4.5'
    case 'claude-3-5-haiku':
      return 'Claude 3.5 Haiku'
    default:
      return normalizeModelStringForApi(model)
  }
}

/**
 * Returns a concise public model name (e.g. `"Opus 4.6"`, `"Sonnet 4.6 (1M context)"`).
 */
export function getPublicModelName(model: string): string {
  const marketing = getMarketingNameForModel(model).replace(/^Claude\s+/, '')
  return has1mContext(model) ? `${marketing} (1M context)` : marketing
}

/**
 * Formats a model name for UI/diagnostic display.
 */
export function renderModelName(model: string): string {
  return getPublicModelName(model)
}

/**
 * Alias for `renderModelName` for model display strings.
 */
export function getPublicModelDisplayName(model: string): string {
  return getPublicModelName(model)
}

/**
 * Formats a model string for CLI/SDK output.
 */
export function modelDisplayString(model: string | null): string {
  if (!model) {
    return renderModelName(getDefaultMainLoopModel())
  }
  return renderModelName(parseUserSpecifiedModel(model))
}

/**
 * Returns a pricing suffix note for Opus 4.6 display (e.g. fast mode).
 */
export function getOpus46PricingSuffix(fastMode: boolean): string {
  return fastMode ? ' ($30/$150 per Mtok)' : ' ($5/$25 per Mtok)'
}
