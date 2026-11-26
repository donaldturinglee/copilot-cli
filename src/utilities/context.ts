/**
 * Context window sizing, output token bounds, and thinking token budgets.
 */

import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './env_utils.js'
import { resolveAntModel } from './model/ant_models.js'
import { getModelCapability } from './model/model_capabilities.js'

export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
export const MODEL_CONTEXT_WINDOW_1M = 1_000_000
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000
export const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
export const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

export interface TokenUsageLike {
  input_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/**
 * Returns true when 1M context windows are explicitly disabled via environment.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.COPILOT_CLI_DISABLE_1M_CONTEXT)
}

/**
 * Returns true if the model string specifies a `[1m]` context window suffix
 * and 1M context is not disabled.
 */
export function has1mContext(model: string): boolean {
  return !is1mContextDisabled() && /\[1m\]/i.test(model)
}

/**
 * Returns true if the given model family supports 1M context windows.
 */
export function modelSupports1m(model: string): boolean {
  const lower = model.toLowerCase()
  return lower.includes('claude-sonnet-4') || lower.includes('opus-4-6')
}

/**
 * Returns true when the Sonnet 4.6 1M experiment treatment is active.
 */
export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (!model.toLowerCase().includes('sonnet-4-6')) {
    return false
  }
  const clientData = getGlobalConfig().clientDataCache
  return clientData?.coral_reef_sonnet === 'true'
}

/**
 * Resolves the effective input context window size (tokens) for a model and
 * optional active beta headers.
 */
export function getContextWindowForModel(
  model: string,
  betas?: readonly string[],
): number {
  if (process.env.USER_TYPE === 'ant' && process.env.COPILOT_CLI_MAX_CONTEXT_TOKENS) {
    const override = Number(process.env.COPILOT_CLI_MAX_CONTEXT_TOKENS)
    if (!Number.isNaN(override) && override > 0) {
      return override
    }
  }

  if (has1mContext(model)) {
    return MODEL_CONTEXT_WINDOW_1M
  }

  const capability = getModelCapability(model)
  if (
    capability?.max_input_tokens !== undefined &&
    capability.max_input_tokens >= 100_000
  ) {
    return is1mContextDisabled()
      ? Math.min(capability.max_input_tokens, MODEL_CONTEXT_WINDOW_DEFAULT)
      : capability.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1m(model)) {
    return MODEL_CONTEXT_WINDOW_1M
  }

  if (getSonnet1mExpTreatmentEnabled(model)) {
    return MODEL_CONTEXT_WINDOW_1M
  }

  const antModel = resolveAntModel(model)
  if (antModel?.contextWindow) {
    return antModel.contextWindow
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * Computes clamped `[0, 100]` context-window used and remaining percentages.
 */
export function calculateContextPercentages(
  currentUsage: TokenUsageLike,
  contextWindowSize: number,
): { used: number; remaining: number } {
  if (contextWindowSize <= 0) {
    return { used: 0, remaining: 100 }
  }
  const totalInput =
    currentUsage.input_tokens +
    (currentUsage.cache_creation_input_tokens ?? 0) +
    (currentUsage.cache_read_input_tokens ?? 0)
  const used = Math.min(
    100,
    Math.max(0, Math.round((totalInput / contextWindowSize) * 100)),
  )
  return { used, remaining: 100 - used }
}

/**
 * Returns default and upper-limit max output token bounds for a model.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  const lower = model.toLowerCase()
  let bounds: { default: number; upperLimit: number }

  if (lower.includes('opus-4-6')) {
    bounds = { default: 64_000, upperLimit: 128_000 }
  } else if (lower.includes('sonnet-4-6')) {
    bounds = { default: 32_000, upperLimit: 128_000 }
  } else if (
    lower.includes('opus-4-5') ||
    lower.includes('sonnet-4') ||
    lower.includes('haiku-4') ||
    lower.includes('3-7-sonnet')
  ) {
    bounds = { default: 32_000, upperLimit: 64_000 }
  } else if (lower.includes('opus-4-1') || lower.includes('opus-4')) {
    bounds = { default: 32_000, upperLimit: 32_000 }
  } else if (
    lower.includes('3-5-sonnet') ||
    lower.includes('3-5-haiku') ||
    lower.includes('claude-3-sonnet')
  ) {
    bounds = { default: 8_192, upperLimit: 8_192 }
  } else if (
    lower.includes('claude-3-opus') ||
    lower.includes('claude-3-haiku')
  ) {
    bounds = { default: 4_096, upperLimit: 4_096 }
  } else {
    bounds = {
      default: MAX_OUTPUT_TOKENS_DEFAULT,
      upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT,
    }
  }

  const capability = getModelCapability(model)
  if (capability?.max_tokens !== undefined && capability.max_tokens >= 4_096) {
    return {
      default: Math.min(bounds.default, capability.max_tokens),
      upperLimit: Math.min(bounds.upperLimit, capability.max_tokens),
    }
  }

  const antModel = resolveAntModel(model)
  if (antModel?.maxOutputTokens) {
    return {
      default: Math.min(bounds.default, antModel.maxOutputTokens),
      upperLimit: antModel.maxOutputTokens,
    }
  }

  return bounds
}

/**
 * Returns the maximum extended thinking token budget for a model (`upperLimit - 1`).
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}

/**
 * Calculates token warning and hard blocking limit status for a conversation.
 */
export function calculateTokenWarningState(
  tokenCount: number,
  model: string,
  betas?: readonly string[],
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const contextWindow = getContextWindowForModel(model, betas)
  const effectiveWindow = Math.max(
    1,
    contextWindow - COMPACT_MAX_OUTPUT_TOKENS,
  )
  const blockingLimit = Math.max(1, effectiveWindow - 3_000)
  const autoCompactThreshold = Math.max(1, effectiveWindow - 13_000)
  const warningThreshold = Math.max(1, effectiveWindow - 20_000)
  const errorThreshold = Math.max(1, effectiveWindow - 10_000)
  const percentLeft = Math.max(
    0,
    Math.min(100, Math.round(((effectiveWindow - tokenCount) / effectiveWindow) * 100)),
  )

  return {
    percentLeft,
    isAboveWarningThreshold: tokenCount >= warningThreshold,
    isAboveErrorThreshold: tokenCount >= errorThreshold,
    isAboveAutoCompactThreshold: tokenCount >= autoCompactThreshold,
    isAtBlockingLimit: tokenCount >= blockingLimit,
  }
}
