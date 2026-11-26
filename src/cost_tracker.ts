/**
 * Per-model token & USD cost accounting, session restore/persistence, and
 * human-readable cost summary formatting.
 */

import chalk from 'chalk'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getCostCounter,
  getModelUsage,
  getSdkBetas,
  getSessionId,
  getTokenCounter,
  getTotalApiDuration,
  getTotalApiDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUsd,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from './bootstrap/state.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from './services/analytics/index.js'
import type { ModelUsage } from './types/forward.js'
import { getAdvisorUsage } from './utilities/advisor.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from './utilities/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utilities/context.js'
import { isFastModeEnabled } from './utilities/fast_mode.js'
import { formatDuration, formatNumber } from './utilities/format.js'
import { getCanonicalName } from './utilities/model/model.js'
import { calculateUsdCost, type CostableUsage } from './utilities/model_cost.js'

export {
  addToTotalLinesChanged,
  formatCost,
  getModelUsage,
  getTotalApiDuration,
  getTotalApiDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUsd as getTotalCost,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setHasUnknownModelCost,
}

export interface FpsMetrics {
  averageFps?: number
  low1PctFps?: number
}

export interface StoredCostState {
  totalCostUsd: number
  totalApiDuration: number
  totalApiDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}

export type SessionUsageLike = CostableUsage & {
  iterations?: ReadonlyArray<Record<string, unknown>>
}

/**
 * Reads persisted cost metrics from project config if they belong to `sessionId`.
 */
export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()
  if (projectConfig.lastSessionId !== sessionId) {
    return undefined
  }

  let modelUsage: { [modelName: string]: ModelUsage } | undefined
  if (projectConfig.lastModelUsage) {
    modelUsage = Object.fromEntries(
      Object.entries(projectConfig.lastModelUsage).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          webSearchRequests: usage.webSearchRequests,
          costUsd: usage.costUSD,
          contextWindow: getContextWindowForModel(model, getSdkBetas()),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        },
      ]),
    )
  }

  return {
    totalCostUsd: projectConfig.lastCost ?? 0,
    totalApiDuration: projectConfig.lastAPIDuration ?? 0,
    totalApiDurationWithoutRetries:
      projectConfig.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
  }
}

/**
 * Restores stored cost state from project config when resuming a matching session.
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/**
 * Persists accumulated session costs and per-model usage to project config.
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUsd(),
    lastAPIDuration: getTotalApiDuration(),
    lastAPIDurationWithoutRetries: getTotalApiDurationWithoutRetries(),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastTotalInputTokens: getTotalInputTokens(),
    lastTotalOutputTokens: getTotalOutputTokens(),
    lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
    lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
    lastTotalWebSearchRequests: getTotalWebSearchRequests(),
    lastFpsAverage: fpsMetrics?.averageFps,
    lastFpsLow1Pct: fpsMetrics?.low1PctFps,
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          webSearchRequests: usage.webSearchRequests,
          costUSD: usage.costUsd,
        },
      ]),
    ),
    lastSessionId: getSessionId(),
  }))
}

function round(num: number, precision: number): number {
  return Math.round(num * precision) / precision
}

function formatCost(cost: number, maxDecimalPlaces = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

function formatModelUsage(): string {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return 'Usage:                 0 input, 0 output, 0 cache read, 0 cache write'
  }

  const usageByShortName: Record<string, ModelUsage> = {}
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = getCanonicalName(model)
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUsd: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
    }
    const accumulated = usageByShortName[shortName]!
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUsd += usage.costUsd
  }

  let result = 'Usage by model:'
  for (const [shortName, usage] of Object.entries(usageByShortName)) {
    const usageString =
      `  ${formatNumber(usage.inputTokens)} input, ` +
      `${formatNumber(usage.outputTokens)} output, ` +
      `${formatNumber(usage.cacheReadInputTokens)} cache read, ` +
      `${formatNumber(usage.cacheCreationInputTokens)} cache write` +
      (usage.webSearchRequests > 0
        ? `, ${formatNumber(usage.webSearchRequests)} web search`
        : '') +
      ` (${formatCost(usage.costUsd)})`
    result += '\n' + `${shortName}:`.padStart(21) + usageString
  }
  return result
}

/**
 * Formats the full dimmed session cost, duration, LOC, and per-model summary.
 */
export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCostUsd()) +
    (hasUnknownModelCost()
      ? ' (costs may be inaccurate due to usage of unknown models)'
      : '')

  const modelUsageDisplay = formatModelUsage()

  return chalk.dim(
    `Total cost:            ${costDisplay}\n` +
      `Total duration (API):  ${formatDuration(getTotalApiDuration())}\n` +
      `Total duration (wall): ${formatDuration(getTotalDuration())}\n` +
      `Total code changes:    ${getTotalLinesAdded()} ${getTotalLinesAdded() === 1 ? 'line' : 'lines'} added, ${getTotalLinesRemoved()} ${getTotalLinesRemoved() === 1 ? 'line' : 'lines'} removed\n` +
      `${modelUsageDisplay}`,
  )
}

function addToTotalModelUsage(
  cost: number,
  usage: SessionUsageLike,
  model: string,
): ModelUsage {
  const modelUsage: ModelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests +=
    usage.server_tool_use?.web_search_requests ?? 0
  modelUsage.costUsd += cost
  modelUsage.contextWindow = getContextWindowForModel(model, getSdkBetas())
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

/**
 * Records a completed API call's cost and token usage into process state, OTel
 * counters, and recursively accounts for any nested advisor iterations.
 */
export function addToTotalSessionCost(
  cost: number,
  usage: SessionUsageLike,
  model: string,
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUsdCost(advisorUsage.model, advisorUsage)
    logEvent('tengu_advisor_tool_token_usage', {
      advisor_model:
        advisorUsage.model as VerifiedNonSensitiveAnalyticsMetadata,
      input_tokens: advisorUsage.input_tokens,
      output_tokens: advisorUsage.output_tokens,
      cache_read_input_tokens: advisorUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens:
        advisorUsage.cache_creation_input_tokens ?? 0,
      cost_usd_micros: Math.round(advisorCost * 1_000_000),
    })
    totalCost += addToTotalSessionCost(
      advisorCost,
      advisorUsage,
      advisorUsage.model,
    )
  }
  return totalCost
}
