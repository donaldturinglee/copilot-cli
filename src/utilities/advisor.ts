/**
 * Server-side Advisor tool (`advisor_20260301`) configuration, block guards,
 * and nested advisor iteration usage extraction.
 */

import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import { shouldIncludeFirstPartyOnlyBetas } from './betas.js'
import { isEnvTruthy } from './env_utils.js'
import { resolveAntModel } from './model/ant_models.js'
import { getCanonicalName } from './model/model.js'
import { getInitialSettings } from './settings/settings.js'

export interface AdvisorServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input?: Record<string, unknown>
}

export interface AdvisorToolResultBlock {
  type: 'advisor_tool_result'
  tool_use_id: string
  content: unknown
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export interface AdvisorIterationUsage {
  type: 'advisor_message'
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }
  speed?: 'standard' | 'fast'
}

interface AdvisorExperimentConfig {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}

export const ADVISOR_TOOL_INSTRUCTIONS =
  'You have access to the advisor server tool for consulting a stronger reasoning model on difficult architecture or debugging decisions.'

/**
 * Type guard identifying server-side advisor tool use or result blocks.
 */
export function isAdvisorBlock(block: unknown): block is AdvisorBlock {
  if (!block || typeof block !== 'object' || !('type' in block)) {
    return false
  }
  const record = block as { type?: unknown; name?: unknown }
  return (
    (record.type === 'server_tool_use' && record.name === 'advisor') ||
    record.type === 'advisor_tool_result'
  )
}

function getAdvisorConfig(): AdvisorExperimentConfig {
  return getFeatureValueCachedMayBeStale<AdvisorExperimentConfig>(
    'tengu_sage_compass',
    {},
  )
}

/**
 * Returns true when the server-side advisor tool is active.
 */
export function isAdvisorEnabled(): boolean {
  if (isEnvTruthy(process.env.COPILOT_CLI_DISABLE_ADVISOR_TOOL)) {
    return false
  }
  if (!shouldIncludeFirstPartyOnlyBetas()) {
    return false
  }
  return Boolean(getAdvisorConfig().enabled)
}

/**
 * Returns true if users may configure a custom advisor model.
 */
export function canUserConfigureAdvisor(): boolean {
  return isAdvisorEnabled() && Boolean(getAdvisorConfig().canUserConfigure)
}

/**
 * Returns configured experiment base/advisor model pair if active.
 */
export function getExperimentAdvisorModels(): {
  baseModel?: string
  advisorModel?: string
} {
  const cfg = getAdvisorConfig()
  return {
    baseModel: cfg.baseModel,
    advisorModel: cfg.advisorModel,
  }
}

/**
 * Returns true if `model` supports the advisor tool (Opus 4.6, Sonnet 4.6, or ant model).
 */
export function modelSupportsAdvisor(model: string): boolean {
  if (resolveAntModel(model)) {
    return true
  }
  const canonical = getCanonicalName(model)
  return canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')
}

/**
 * Returns true if `model` is valid as an advisor model target.
 */
export function isValidAdvisorModel(model: string): boolean {
  return modelSupportsAdvisor(model)
}

/**
 * Resolves the initial advisor model setting from user settings or experiment config.
 */
export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) {
    return undefined
  }
  return getInitialSettings().advisorModel ?? getAdvisorConfig().advisorModel
}

/**
 * Extracts nested `advisor_message` iteration usage entries from an API usage payload.
 */
export function getAdvisorUsage(usage: {
  iterations?: ReadonlyArray<Record<string, unknown>>
}): AdvisorIterationUsage[] {
  if (!Array.isArray(usage.iterations)) {
    return []
  }
  const results: AdvisorIterationUsage[] = []
  for (const item of usage.iterations) {
    if (
      item &&
      typeof item === 'object' &&
      item.type === 'advisor_message' &&
      typeof item.model === 'string' &&
      typeof item.input_tokens === 'number' &&
      typeof item.output_tokens === 'number'
    ) {
      results.push(item as unknown as AdvisorIterationUsage)
    }
  }
  return results
}
