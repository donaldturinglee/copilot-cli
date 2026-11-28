/**
 * Autocompact threshold math, circuit breaker (3 consecutive failures), and
 * Tier 4a (`trySessionMemoryCompaction`) -> Tier 4b (`compactConversation`)
 * orchestrator (`autoCompactIfNeeded`).
 */

import { getSdkBetas, markPostCompaction } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/query_source.js'
import type {
  AutoCompactResult,
  AutoCompactTrackingState,
  QueryDeps,
} from '../../query/deps.js'
import type { ToolUseContext } from '../../types/forward.js'
import type { Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utilities/cache_safe_params.js'
import { getGlobalConfig } from '../../utilities/config.js'
import { getContextWindowForModel } from '../../utilities/context.js'
import { logForDebugging } from '../../utilities/debug.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import { isFeatureEnabled } from '../../utilities/feature_flags.js'
import { logError } from '../../utilities/log.js'
import { getDefaultMainLoopModel } from '../../utilities/model/model.js'
import { tokenCountWithEstimation } from '../../utilities/tokens.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/prompt_cache_break_detection.js'
import { setLastSummarizedMessageId } from '../session_memory/session_memory_utils.js'
import {
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './post_compact_cleanup.js'
import { trySessionMemoryCompaction } from './session_memory_compact.js'

export type { AutoCompactTrackingState }

export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

/**
 * Returns the effective context window size:
 * `min(modelContextWindow, COPILOT_CLI_AUTO_COMPACT_WINDOW) - min(modelMaxOutput, 20_000)`.
 */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindowRaw =
    process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW ??
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindowRaw) {
    const parsed = Number.parseInt(autoCompactWindowRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return Math.max(1, contextWindow - reservedForSummary)
}

/**
 * Returns the token count at which automatic compaction triggers:
 * `effectiveWindow - 13_000`, optionally lowered by
 * `COPILOT_CLI_AUTOCOMPACT_PCT_OVERRIDE` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
 */
export function getAutoCompactThreshold(model: string): number {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const defaultThreshold = Math.max(1, effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS)

  const envPctRaw =
    process.env.COPILOT_CLI_AUTOCOMPACT_PCT_OVERRIDE ??
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPctRaw) {
    const parsed = Number(envPctRaw)
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100) {
      const pctThreshold = Math.max(
        1,
        Math.floor(effectiveWindow * (parsed / 100)),
      )
      return Math.min(pctThreshold, defaultThreshold)
    }
  }

  return defaultThreshold
}

/**
 * Returns whether automatic compaction is enabled (respecting `DISABLE_COMPACT`,
 * `DISABLE_AUTO_COMPACT`, and `GlobalConfig.autoCompactEnabled`).
 */
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  return getGlobalConfig().autoCompactEnabled !== false
}

/**
 * Calculates warning, error, auto-compact, and blocking-ceiling states for the
 * given token usage against `model`'s effective window.
 */
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const autoEnabled = isAutoCompactEnabled()
  const threshold = autoEnabled ? autoCompactThreshold : effectiveWindow

  const percentLeft = Math.max(
    0,
    Math.min(100, Math.round(((threshold - tokenUsage) / Math.max(1, threshold)) * 100)),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const defaultBlockingLimit = Math.max(
    1,
    effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS,
  )
  const blockingOverrideRaw =
    process.env.COPILOT_CLI_BLOCKING_LIMIT_OVERRIDE ??
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedBlockingOverride = blockingOverrideRaw
    ? Number.parseInt(blockingOverrideRaw, 10)
    : Number.NaN
  const blockingLimit =
    Number.isFinite(parsedBlockingOverride) && parsedBlockingOverride > 0
      ? parsedBlockingOverride
      : defaultBlockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold:
      autoEnabled && tokenUsage >= autoCompactThreshold,
    isAtBlockingLimit: tokenUsage >= blockingLimit,
  }
}

/**
 * Determines whether automatic compaction should trigger for `messages`.
 */
export async function shouldAutoCompact(
  messages: readonly Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0,
): Promise<boolean> {
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  if (!isAutoCompactEnabled()) {
    return false
  }

  const tokenCount = Math.max(
    0,
    tokenCountWithEstimation(messages) - snipTokensFreed,
  )
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  return calculateTokenWarningState(tokenCount, model)
    .isAboveAutoCompactThreshold
}

/**
 * Primary Tier 4 autocompact entry wired into `QueryDeps.autocompact`:
 * 1. Guards against `DISABLE_COMPACT` and the 3-failure circuit breaker.
 * 2. Tries Tier 4a (`trySessionMemoryCompaction`) first (zero LLM calls).
 * 3. Falls back to Tier 4b (`compactConversation`), tracking consecutive
 *    failures so doomed compaction loops halt after 3 attempts.
 */
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed = 0,
  depsOverride?: QueryDeps,
): Promise<AutoCompactResult> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const ctxOpts =
    (toolUseContext.options as { mainLoopModel?: string } | undefined) ?? {}
  const model = ctxOpts.mainLoopModel ?? getDefaultMainLoopModel()

  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )
  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  const agentId =
    typeof toolUseContext.agentId === 'string'
      ? toolUseContext.agentId
      : undefined

  // Tier 4a: Try zero-LLM Session Memory Compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    if (isFeatureEnabled('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
      consecutiveFailures: 0,
    }
  }

  // Tier 4b: Full LLM compaction
  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true,
      undefined,
      true,
      recompactionInfo,
      depsOverride ? { deps: depsOverride } : undefined,
    )

    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      consecutiveFailures: 0,
    }
  } catch (error) {
    const isUserAbort =
      error instanceof Error && error.message === ERROR_MESSAGE_USER_ABORT
    if (!isUserAbort) {
      logError(error)
    }
    const nextFailures = (tracking?.consecutiveFailures ?? 0) + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,
    }
  }
}
