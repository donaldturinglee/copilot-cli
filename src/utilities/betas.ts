/**
 * Beta header assembly, SDK beta allowlist filtering, provider capability checks,
 * and sticky beta latch integration for Prompt Cache stability.
 */

import memoize from 'lodash-es/memoize.js'
import {
  getIsNonInteractiveSession,
  getSdkBetas,
} from '../bootstrap/state.js'
import {
  BEDROCK_EXTRA_PARAMS_HEADERS,
  CLAUDE_CODE_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  getCliInternalBetaHeader,
  getSummarizeConnectorTextBetaHeader,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
  TOOL_SEARCH_BETA_HEADER_3P,
  WEB_SEARCH_BETA_HEADER,
} from '../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import {
  isClaudeAiSubscriber,
  registerAuthCacheInvalidator,
} from './auth.js'
import { has1mContext } from './context.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './env_utils.js'
import { isFeatureEnabled } from './feature_flags.js'
import { getCanonicalName } from './model/model.js'
import { get3pModelCapabilityOverride } from './model/model_support_overrides.js'
import { getApiProvider } from './model/providers.js'
import { getInitialSettings } from './settings/settings.js'

export const ALLOWED_SDK_BETAS: readonly string[] = [CONTEXT_1M_BETA_HEADER]

/**
 * Filters user/SDK-supplied `--betas` values against the allowlist (disabled for
 * Claude.ai subscribers).
 */
export function filterAllowedSdkBetas(sdkBetas: readonly string[]): {
  allowed: string[]
  disallowed: string[]
} {
  if (isClaudeAiSubscriber()) {
    if (sdkBetas.length > 0) {
      logForDebugging(
        'SDK --betas are disabled for Claude.ai subscribers; ignoring.',
      )
    }
    return { allowed: [], disallowed: [...sdkBetas] }
  }
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of sdkBetas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  if (disallowed.length > 0) {
    logForDebugging(`Ignoring disallowed SDK betas: ${disallowed.join(', ')}`)
  }
  return { allowed, disallowed }
}

/**
 * Returns true if first-party-only experimental betas should be sent.
 */
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  const provider = getApiProvider()
  return (
    (provider === 'firstParty' || provider === 'foundry') &&
    !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * Returns true when prompt caching may use `scope: 'global'` system prompt blocks.
 */
export function shouldUseGlobalCacheScope(): boolean {
  return (
    getApiProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * Returns true if a model supports interleaved thinking (`interleaved-thinking-2025-05-14`).
 */
export function modelSupportsIsp(model: string): boolean {
  const override = get3pModelCapabilityOverride(model, 'interleaved_thinking')
  if (override !== undefined) {
    return override
  }
  const provider = getApiProvider()
  if (provider === 'foundry') {
    return true
  }
  const canonical = getCanonicalName(model)
  if (provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') || canonical.includes('claude-sonnet-4')
  )
}

/**
 * Returns true if a model supports API context management (`context-management-2025-06-27`).
 */
export function modelSupportsContextManagement(model: string): boolean {
  const provider = getApiProvider()
  if (provider === 'foundry') {
    return true
  }
  const canonical = getCanonicalName(model)
  if (provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('claude-haiku-4')
  )
}

/**
 * Returns true if a model supports structured JSON outputs.
 */
export function modelSupportsStructuredOutputs(model: string): boolean {
  const provider = getApiProvider()
  if (provider !== 'firstParty' && provider !== 'foundry') {
    return false
  }
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('sonnet-4-6') ||
    canonical.includes('sonnet-4-5') ||
    canonical.includes('opus-4-1') ||
    canonical.includes('opus-4-5') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('haiku-4-5')
  )
}

/**
 * Returns true if a model supports auto permission classifier mode.
 */
export function modelSupportsAutoMode(model: string): boolean {
  if (!isFeatureEnabled('TRANSCRIPT_CLASSIFIER')) {
    return false
  }
  const config = getFeatureValueCachedMayBeStale<{ allowModels?: string[] }>(
    'tengu_auto_mode_config',
    {},
  )
  const canonical = getCanonicalName(model)
  if (config.allowModels && config.allowModels.length > 0) {
    return config.allowModels.some(allowed => canonical.includes(allowed))
  }
  if (getApiProvider() !== 'firstParty') {
    return false
  }
  return /^claude-(opus|sonnet)-4-6/.test(canonical)
}

/**
 * Returns the provider-appropriate tool-search beta header.
 */
export function getToolSearchBetaHeader(): string {
  const provider = getApiProvider()
  if (provider === 'vertex' || provider === 'bedrock') {
    return TOOL_SEARCH_BETA_HEADER_3P
  }
  return TOOL_SEARCH_BETA_HEADER_1P
}

const getAllModelBetas = memoize((model: string): string[] => {
  const betas: string[] = []
  const provider = getApiProvider()
  const canonical = getCanonicalName(model)
  const isHaiku = canonical.includes('haiku')
  const includeFirstPartyOnly = shouldIncludeFirstPartyOnlyBetas()

  if (!isHaiku) {
    betas.push(CLAUDE_CODE_20250219_BETA_HEADER)
    const internalBeta = getCliInternalBetaHeader()
    if (internalBeta) {
      betas.push(internalBeta)
    }
  }

  if (isClaudeAiSubscriber()) {
    betas.push(OAUTH_BETA_HEADER)
  }

  if (has1mContext(model)) {
    betas.push(CONTEXT_1M_BETA_HEADER)
  }

  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsIsp(model)
  ) {
    betas.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  if (
    includeFirstPartyOnly &&
    modelSupportsIsp(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betas.push(REDACT_THINKING_BETA_HEADER)
  }

  const connectorBeta = getSummarizeConnectorTextBetaHeader()
  if (connectorBeta) {
    const envFlag = process.env.USE_CONNECTOR_TEXT_SUMMARIZATION
    const enabled = isEnvTruthy(envFlag)
      ? true
      : isEnvDefinedFalsy(envFlag)
        ? false
        : getFeatureValueCachedMayBeStale('tengu_slate_prism', false)
    if (enabled) {
      betas.push(connectorBeta)
    }
  }

  if (
    includeFirstPartyOnly &&
    (isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) ||
      modelSupportsContextManagement(model))
  ) {
    betas.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }

  const strictTools = getFeatureValueCachedMayBeStale('tengu_tool_pear', false)
  const tokenEfficientTools =
    process.env.USER_TYPE === 'ant' &&
    getFeatureValueCachedMayBeStale('tengu_amber_json_tools', false)
  if (strictTools && modelSupportsStructuredOutputs(model)) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  } else if (tokenEfficientTools && includeFirstPartyOnly) {
    betas.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }

  if (
    provider === 'foundry' ||
    (provider === 'vertex' && !canonical.includes('claude-3-'))
  ) {
    betas.push(WEB_SEARCH_BETA_HEADER)
  }

  if (includeFirstPartyOnly) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  if (process.env.ANTHROPIC_BETAS) {
    for (const raw of process.env.ANTHROPIC_BETAS.split(',')) {
      const trimmed = raw.trim()
      if (trimmed) {
        betas.push(trimmed)
      }
    }
  }

  return Array.from(new Set(betas))
})

/**
 * Returns beta headers to pass on HTTP headers for `model` (excluding Bedrock
 * extra-body-only betas when running on Bedrock).
 */
export const getModelBetas = memoize((model: string): string[] => {
  const all = getAllModelBetas(model)
  if (getApiProvider() === 'bedrock') {
    return all.filter(b => !BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  }
  return [...all]
})

/**
 * Returns the subset of betas that Bedrock expects inside the request body's
 * `anthropic_beta` field rather than HTTP headers.
 */
export const getBedrockExtraBodyParamsBetas = memoize(
  (model: string): string[] => {
    if (getApiProvider() !== 'bedrock') {
      return []
    }
    return getAllModelBetas(model).filter(b =>
      BEDROCK_EXTRA_PARAMS_HEADERS.has(b),
    )
  },
)

/**
 * Returns merged model betas + agentic query headers + allowed SDK betas.
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const betas = [...getModelBetas(model)]
  if (options?.isAgenticQuery) {
    if (!betas.includes(CLAUDE_CODE_20250219_BETA_HEADER)) {
      betas.push(CLAUDE_CODE_20250219_BETA_HEADER)
    }
    const internalBeta = getCliInternalBetaHeader()
    if (internalBeta && !betas.includes(internalBeta)) {
      betas.push(internalBeta)
    }
  }
  const sdkBetas = getSdkBetas()
  if (sdkBetas && sdkBetas.length > 0) {
    const { allowed } = filterAllowedSdkBetas(sdkBetas)
    for (const beta of allowed) {
      if (!betas.includes(beta)) {
        betas.push(beta)
      }
    }
  }
  return betas
}

/**
 * Clears all memoized beta header caches.
 */
export function clearBetasCaches(): void {
  getAllModelBetas.cache.clear?.()
  getModelBetas.cache.clear?.()
  getBedrockExtraBodyParamsBetas.cache.clear?.()
}

registerAuthCacheInvalidator(clearBetasCaches)
