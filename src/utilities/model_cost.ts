/**
 * Per-model token and web-search pricing table and USD cost calculation.
 */

import { setHasUnknownModelCost } from '../bootstrap/state.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'
import { isFastModeEnabled } from './fast_mode.js'
import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'

export interface ModelCosts {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

export interface CostableUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  server_tool_use?: {
    web_search_requests?: number
    web_fetch_requests?: number
  } | null
  speed?: 'standard' | 'fast'
}

export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST: ModelCosts = COST_TIER_5_25

/**
 * Returns the cost tier for Opus 4.6 (`$30/$150` in fast mode, `$5/$25` normal).
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(CLAUDE_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonical(CLAUDE_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
}

function tokensToUsdCost(modelCosts: ModelCosts, usage: CostableUsage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as VerifiedNonSensitiveAnalyticsMetadata,
    shortName: shortName as VerifiedNonSensitiveAnalyticsMetadata,
  })
  setHasUnknownModelCost()
}

/**
 * Looks up per-Mtok pricing rates for `model` and `usage`.
 */
export function getModelCosts(
  model: string,
  usage: CostableUsage,
): ModelCosts {
  const shortName = getCanonicalName(model)

  if (
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)
  ) {
    return getOpus46CostTier(usage.speed === 'fast')
  }

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return (
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

/**
 * Calculates the USD cost of a single API response.
 */
export function calculateUsdCost(
  resolvedModel: string,
  usage: CostableUsage,
): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUsdCost(modelCosts, usage)
}

/**
 * Calculates USD cost from raw token counts without a full API usage payload.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  return calculateUsdCost(model, {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  })
}

function formatPrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`
}

/**
 * Formats model costs as `"$3/$15 per Mtok"`.
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Returns formatted pricing string for `model`, or `undefined` if unknown.
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    return undefined
  }
  return formatModelPricing(costs)
}
