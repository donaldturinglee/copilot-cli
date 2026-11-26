/**
 * Configurable mock rate-limit scenarios for local and automated testing of
 * 429 limits, early warnings, overage transitions, and fast-mode cooldowns.
 */

import { APIError } from '@anthropic-ai/sdk'
import { setMockBillingAccessOverride } from '../utilities/billing.js'
import { registerMockRateLimitInterceptor } from './rate_limit_mocking.js'

export type MockRateLimitScenario =
  | 'none'
  | 'warning_5h'
  | 'warning_7d'
  | 'rejected_5h'
  | 'rejected_7d'
  | 'overage_active'
  | 'overage_warning'
  | 'overage_out_of_credits'

let activeScenario: MockRateLimitScenario = 'none'
let customHeadersOverride: Record<string, string> | null = null

function buildScenarioHeaders(
  scenario: MockRateLimitScenario,
): Record<string, string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const reset5h = String(nowSec + 3600)
  const reset7d = String(nowSec + 86_400 * 3)

  switch (scenario) {
    case 'warning_5h':
      return {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': reset5h,
        'anthropic-ratelimit-unified-5h-utilization': '0.92',
        'anthropic-ratelimit-unified-5h-reset': reset5h,
        'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9',
      }
    case 'warning_7d':
      return {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-ratelimit-unified-reset': reset7d,
        'anthropic-ratelimit-unified-7d-utilization': '0.8',
        'anthropic-ratelimit-unified-7d-reset': reset7d,
        'anthropic-ratelimit-unified-7d-surpassed-threshold': '0.75',
      }
    case 'rejected_5h':
      return {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': reset5h,
        'anthropic-ratelimit-unified-fallback': 'available',
      }
    case 'rejected_7d':
      return {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-ratelimit-unified-reset': reset7d,
      }
    case 'overage_active':
      return {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': reset5h,
        'anthropic-ratelimit-unified-overage-status': 'allowed',
      }
    case 'overage_warning':
      return {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': reset5h,
        'anthropic-ratelimit-unified-overage-status': 'allowed_warning',
      }
    case 'overage_out_of_credits':
      return {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': reset5h,
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
      }
    case 'none':
    default:
      return {}
  }
}

function createMock429Error(headersObj: Record<string, string>): APIError {
  const headers = new Headers(headersObj)
  const err = new APIError(
    429,
    {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Mock rate limit exceeded' },
    },
    'Mock rate limit exceeded',
    headers,
  )
  ;(err as APIError & { isMockRateLimitError?: boolean }).isMockRateLimitError =
    true
  return err
}

/**
 * Activates a mock rate-limit scenario (or `'none'` to disable).
 */
export function setMockRateLimitScenario(
  scenario: MockRateLimitScenario,
  customHeaders?: Record<string, string>,
): void {
  activeScenario = scenario
  customHeadersOverride = customHeaders ?? null

  if (scenario === 'none' && !customHeaders) {
    registerMockRateLimitInterceptor(null)
    setMockBillingAccessOverride(null)
    return
  }

  setMockBillingAccessOverride(true)
  registerMockRateLimitInterceptor({
    isActive: () =>
      activeScenario !== 'none' || customHeadersOverride !== null,
    processHeaders: incoming => {
      const merged = new Headers(incoming)
      const overlay =
        customHeadersOverride ?? buildScenarioHeaders(activeScenario)
      for (const [k, v] of Object.entries(overlay)) {
        merged.set(k, v)
      }
      return merged
    },
    checkError: () => {
      if (
        activeScenario === 'rejected_5h' ||
        activeScenario === 'rejected_7d' ||
        activeScenario === 'overage_out_of_credits'
      ) {
        return createMock429Error(
          customHeadersOverride ?? buildScenarioHeaders(activeScenario),
        )
      }
      return null
    },
  })
}

/**
 * Returns the currently active mock rate-limit scenario name.
 */
export function getMockRateLimitScenario(): MockRateLimitScenario {
  return activeScenario
}

/**
 * Resets all mock rate-limit state.
 */
export function resetMockRateLimits(): void {
  setMockRateLimitScenario('none')
}
