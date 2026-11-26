/**
 * Turn-level token budget continuation evaluator (`<90%` completion threshold
 * with diminishing-returns circuit breaker `<500` tokens across consecutive checks).
 */

import { getBudgetContinuationMessage } from '../utilities/token_budget.js'

export const COMPLETION_THRESHOLD = 0.9
export const DIMINISHING_THRESHOLD = 500

export interface BudgetTracker {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

export interface TokenBudgetCompletionEvent {
  continuationCount: number
  pct: number
  turnTokens: number
  budget: number
  diminishingReturns: boolean
  durationMs: number
}

export type TokenBudgetDecision =
  | {
      action: 'continue'
      nudgeMessage: string
      continuationCount: number
      pct: number
      turnTokens: number
      budget: number
    }
  | {
      action: 'stop'
      completionEvent: TokenBudgetCompletionEvent | null
    }

/**
 * Creates a fresh per-turn `BudgetTracker`.
 */
export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

/**
 * Evaluates whether the main turn should nudge continuation to approach `budget`
 * or stop (at >=90% completion or on diminishing returns after >=3 continuations).
 */
export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  if (agentId || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }

  const turnTokens = globalTurnTokens
  const pct = Math.round((turnTokens / budget) * 100)
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = globalTurnTokens
    return {
      action: 'continue',
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    }
  }

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    }
  }

  return { action: 'stop', completionEvent: null }
}
