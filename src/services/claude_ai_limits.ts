/**
 * Claude.ai unified rate-limit header tracking, early-warning thresholds,
 * raw utilization snapshots, and pub/sub status listeners.
 */

import type { APIError } from '@anthropic-ai/sdk'
import isEqual from 'lodash-es/isEqual.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { isClaudeAiSubscriber } from '../utilities/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utilities/config.js'
import { getSmallFastModel } from '../utilities/model/model.js'
import { isEssentialTrafficOnly } from '../utilities/privacy_level.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from './analytics/index.js'
import { getAnthropicClient } from './api/client.js'
import {
  type ClaudeAiLimits,
  getRateLimitDisplayName,
  getRateLimitErrorMessage,
  getRateLimitWarning,
  getUsingOverageText,
  type OverageDisabledReason,
  type QuotaStatus,
  type RateLimitType,
} from './rate_limit_messages.js'
import {
  processRateLimitHeaders,
  shouldProcessRateLimits,
} from './rate_limit_mocking.js'

export {
  getRateLimitDisplayName,
  getRateLimitErrorMessage,
  getRateLimitWarning,
  getUsingOverageText,
  type ClaudeAiLimits,
  type OverageDisabledReason,
  type QuotaStatus,
  type RateLimitType,
}

export interface RawUtilization {
  five_hour?: { utilization: number; resets_at: number }
  seven_day?: { utilization: number; resets_at: number }
}

const DEFAULT_LIMITS: ClaudeAiLimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

let currentLimitsState: ClaudeAiLimits = { ...DEFAULT_LIMITS }
let rawUtilizationState: RawUtilization = {}

export const statusListeners = new Set<(limits: ClaudeAiLimits) => void>()

/**
 * Returns the latest parsed Claude.ai quota limits snapshot.
 */
export function getCurrentLimits(): ClaudeAiLimits {
  return currentLimitsState
}

/**
 * Returns raw 5h/7d utilization metrics extracted from API response headers.
 */
export function getRawUtilization(): RawUtilization {
  return { ...rawUtilizationState }
}

/**
 * Updates active limits, logs telemetry, and notifies all subscribed listeners.
 */
export function emitStatusChange(limits: ClaudeAiLimits): void {
  currentLimitsState = { ...limits }
  logEvent('tengu_claudeai_limits_status_changed', {
    status: limits.status as VerifiedNonSensitiveAnalyticsMetadata,
    isUsingOverage: Boolean(limits.isUsingOverage),
  })
  for (const listener of statusListeners) {
    try {
      listener({ ...currentLimitsState })
    } catch {
      // Never let one subscriber break others
    }
  }
}

/**
 * Resets tracked rate-limit state (for tests or logout).
 */
export function resetClaudeAiLimitsForTesting(): void {
  currentLimitsState = { ...DEFAULT_LIMITS }
  rawUtilizationState = {}
  statusListeners.clear()
}

function parseOptionalNumber(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  const num = Number(raw)
  return Number.isNaN(num) ? undefined : num
}

function toHeaders(
  input: Headers | Record<string, string | undefined> | undefined | null,
): Headers {
  if (!input) {
    return new Headers()
  }
  if (input instanceof Headers) {
    return input
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) {
      headers.set(k, v)
    }
  }
  return headers
}

const CLAIM_MAP: ReadonlyArray<{
  abbrev: '5h' | '7d' | 'overage'
  type: RateLimitType
}> = [
  { abbrev: '5h', type: 'five_hour' },
  { abbrev: '7d', type: 'seven_day' },
  { abbrev: 'overage', type: 'overage' },
]

const EARLY_WARNING_WINDOWS: ReadonlyArray<{
  abbrev: '5h' | '7d'
  type: RateLimitType
  windowSeconds: number
  thresholds: ReadonlyArray<{ utilization: number; timePct: number }>
}> = [
  {
    abbrev: '5h',
    type: 'five_hour',
    windowSeconds: 18_000,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    abbrev: '7d',
    type: 'seven_day',
    windowSeconds: 604_800,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
]

function computeNewLimitsFromHeaders(headers: Headers): ClaudeAiLimits {
  const status =
    (headers.get('anthropic-ratelimit-unified-status') as QuotaStatus | null) ??
    'allowed'
  const resetsAt = parseOptionalNumber(
    headers.get('anthropic-ratelimit-unified-reset'),
  )
  const unifiedRateLimitFallbackAvailable =
    headers.get('anthropic-ratelimit-unified-fallback') === 'available'
  const rateLimitType =
    (headers.get(
      'anthropic-ratelimit-unified-representative-claim',
    ) as RateLimitType | null) ?? undefined
  const overageStatus =
    (headers.get(
      'anthropic-ratelimit-unified-overage-status',
    ) as QuotaStatus | null) ?? undefined
  const overageResetsAt = parseOptionalNumber(
    headers.get('anthropic-ratelimit-unified-overage-reset'),
  )
  const overageDisabledReason =
    (headers.get(
      'anthropic-ratelimit-unified-overage-disabled-reason',
    ) as OverageDisabledReason | null) ?? undefined

  const isUsingOverage =
    status === 'rejected' &&
    (overageStatus === 'allowed' || overageStatus === 'allowed_warning')

  if (status === 'allowed' || status === 'allowed_warning') {
    // 1. Header-driven surpassed-threshold warning (5h -> 7d -> overage)
    for (const claim of CLAIM_MAP) {
      const thresholdStr = headers.get(
        `anthropic-ratelimit-unified-${claim.abbrev}-surpassed-threshold`,
      )
      if (thresholdStr !== null) {
        const surpassedThreshold = parseOptionalNumber(thresholdStr)
        const claimReset =
          parseOptionalNumber(
            headers.get(`anthropic-ratelimit-unified-${claim.abbrev}-reset`),
          ) ?? resetsAt
        const claimUtil = parseOptionalNumber(
          headers.get(
            `anthropic-ratelimit-unified-${claim.abbrev}-utilization`,
          ),
        )
        return {
          status: 'allowed_warning',
          unifiedRateLimitFallbackAvailable,
          resetsAt: claimReset,
          rateLimitType: claim.type,
          utilization: claimUtil,
          overageStatus,
          overageResetsAt,
          overageDisabledReason,
          isUsingOverage: false,
          surpassedThreshold,
        }
      }
    }

    // 2. Time-relative early warning fallback
    const nowSec = Date.now() / 1000
    for (const win of EARLY_WARNING_WINDOWS) {
      const util = parseOptionalNumber(
        headers.get(`anthropic-ratelimit-unified-${win.abbrev}-utilization`),
      )
      const reset = parseOptionalNumber(
        headers.get(`anthropic-ratelimit-unified-${win.abbrev}-reset`),
      )
      if (util !== undefined && reset !== undefined) {
        const elapsed = nowSec - (reset - win.windowSeconds)
        const timeProgress = Math.max(
          0,
          Math.min(1, elapsed / win.windowSeconds),
        )
        const triggered = win.thresholds.some(
          t => util >= t.utilization && timeProgress <= t.timePct,
        )
        if (triggered) {
          return {
            status: 'allowed_warning',
            unifiedRateLimitFallbackAvailable,
            resetsAt: reset,
            rateLimitType: win.type,
            utilization: util,
            overageStatus,
            overageResetsAt,
            overageDisabledReason,
            isUsingOverage: false,
          }
        }
      }
    }

    return {
      status: 'allowed',
      unifiedRateLimitFallbackAvailable,
      resetsAt,
      rateLimitType,
      overageStatus,
      overageResetsAt,
      overageDisabledReason,
      isUsingOverage: false,
    }
  }

  return {
    status,
    unifiedRateLimitFallbackAvailable,
    resetsAt,
    rateLimitType,
    overageStatus,
    overageResetsAt,
    overageDisabledReason,
    isUsingOverage,
  }
}

function updateRawUtilization(headers: Headers): void {
  const next: RawUtilization = {}
  const u5 = parseOptionalNumber(
    headers.get('anthropic-ratelimit-unified-5h-utilization'),
  )
  const r5 = parseOptionalNumber(
    headers.get('anthropic-ratelimit-unified-5h-reset'),
  )
  if (u5 !== undefined && r5 !== undefined) {
    next.five_hour = { utilization: u5, resets_at: r5 }
  }
  const u7 = parseOptionalNumber(
    headers.get('anthropic-ratelimit-unified-7d-utilization'),
  )
  const r7 = parseOptionalNumber(
    headers.get('anthropic-ratelimit-unified-7d-reset'),
  )
  if (u7 !== undefined && r7 !== undefined) {
    next.seven_day = { utilization: u7, resets_at: r7 }
  }
  rawUtilizationState = next
}

/**
 * Extracts rate-limit quota status from successful API response headers.
 */
export function extractQuotaStatusFromHeaders(
  rawHeaders: Headers | Record<string, string | undefined> | undefined | null,
): void {
  if (!shouldProcessRateLimits(isClaudeAiSubscriber())) {
    if (!isEqual(currentLimitsState, DEFAULT_LIMITS)) {
      currentLimitsState = { ...DEFAULT_LIMITS }
    }
    rawUtilizationState = {}
    return
  }

  const headers = processRateLimitHeaders(toHeaders(rawHeaders))
  updateRawUtilization(headers)
  const newLimits = computeNewLimitsFromHeaders(headers)

  const disabledReason = newLimits.overageDisabledReason ?? null
  if (getGlobalConfig().cachedExtraUsageDisabledReason !== disabledReason) {
    saveGlobalConfig(prev => ({
      ...prev,
      cachedExtraUsageDisabledReason: disabledReason,
    }))
  }

  if (!isEqual(currentLimitsState, newLimits)) {
    emitStatusChange(newLimits)
  }
}

/**
 * Extracts rate-limit quota status from an HTTP 429 `APIError`.
 */
export function extractQuotaStatusFromError(error: APIError): void {
  if (!shouldProcessRateLimits(isClaudeAiSubscriber()) || error.status !== 429) {
    return
  }
  const headers = processRateLimitHeaders(
    toHeaders(
      error.headers as Headers | Record<string, string | undefined> | undefined,
    ),
  )
  updateRawUtilization(headers)
  const newLimits = computeNewLimitsFromHeaders(headers)
  newLimits.status = 'rejected'
  if (!isEqual(currentLimitsState, newLimits)) {
    emitStatusChange(newLimits)
  }
}

/**
 * Sends a minimal Haiku probe to refresh interactive quota limits.
 */
export async function checkQuotaStatus(): Promise<void> {
  if (
    isEssentialTrafficOnly() ||
    !shouldProcessRateLimits(isClaudeAiSubscriber()) ||
    getIsNonInteractiveSession()
  ) {
    return
  }
  try {
    const model = getSmallFastModel()
    const client = await getAnthropicClient({
      maxRetries: 0,
      model,
      source: 'quota_check',
    })
    const response = await client.beta.messages
      .create({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'quota' }],
      })
      .asResponse()
    extractQuotaStatusFromHeaders(response.headers)
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      extractQuotaStatusFromError(error as APIError)
    }
  }
}
