/**
 * User-facing rate limit error, warning, and overage banner messages.
 */

export type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

export type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage'

export type OverageDisabledReason =
  | 'overage_not_provisioned'
  | 'org_level_disabled'
  | 'org_level_disabled_until'
  | 'out_of_credits'
  | 'seat_tier_level_disabled'
  | 'member_level_disabled'
  | 'seat_tier_zero_credit_limit'
  | 'group_zero_credit_limit'
  | 'member_zero_credit_limit'
  | 'org_service_level_disabled'
  | 'org_service_zero_credit_limit'
  | 'no_limits_configured'
  | 'unknown'

export interface ClaudeAiLimits {
  status: QuotaStatus
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number
  rateLimitType?: RateLimitType
  utilization?: number
  overageStatus?: QuotaStatus
  overageResetsAt?: number
  overageDisabledReason?: OverageDisabledReason
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

export interface RateLimitMessage {
  message: string
  severity: 'error' | 'warning'
}

export const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

/**
 * Returns true if `text` starts with a known user-facing rate limit message prefix.
 */
export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

/**
 * Maps a `RateLimitType` to its human-readable quota window label.
 */
export function getRateLimitDisplayName(type?: RateLimitType): string {
  switch (type) {
    case 'five_hour':
      return 'session limit'
    case 'seven_day':
      return 'weekly limit'
    case 'seven_day_opus':
      return 'Opus limit'
    case 'seven_day_sonnet':
      return 'Sonnet limit'
    case 'overage':
      return 'extra usage limit'
    default:
      return 'limit'
  }
}

function formatResetTime(resetsAtUnixSeconds?: number): string {
  if (!resetsAtUnixSeconds) {
    return ''
  }
  const date = new Date(resetsAtUnixSeconds * 1000)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return ` · resets ${date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

function getLimitReachedText(limits: ClaudeAiLimits, _model?: string): string {
  if (limits.overageStatus === 'rejected') {
    const earliestReset =
      limits.resetsAt !== undefined && limits.overageResetsAt !== undefined
        ? Math.min(limits.resetsAt, limits.overageResetsAt)
        : (limits.resetsAt ?? limits.overageResetsAt)
    if (limits.overageDisabledReason === 'out_of_credits') {
      return `You're out of extra usage${formatResetTime(earliestReset)}`
    }
    return `You've hit your ${getRateLimitDisplayName(limits.rateLimitType)}${formatResetTime(earliestReset)}`
  }
  return `You've hit your ${getRateLimitDisplayName(limits.rateLimitType)}${formatResetTime(limits.resetsAt)}`
}

/**
 * Computes the rate-limit banner message and severity, or `null` if none applies.
 */
export function getRateLimitMessage(
  limits: ClaudeAiLimits,
  model?: string,
): RateLimitMessage | null {
  if (limits.isUsingOverage) {
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: "You're close to your extra usage spending limit",
        severity: 'warning',
      }
    }
    return null
  }

  if (limits.status === 'rejected') {
    return {
      message: getLimitReachedText(limits, model),
      severity: 'error',
    }
  }

  if (limits.status === 'allowed_warning') {
    const pct =
      limits.utilization !== undefined
        ? `${Math.round(limits.utilization * 100)}% of your `
        : ''
    const label = getRateLimitDisplayName(limits.rateLimitType)
    return {
      message: pct
        ? `You've used ${pct}${label}${formatResetTime(limits.resetsAt)}`
        : `You're close to your ${label}${formatResetTime(limits.resetsAt)}`,
      severity: 'warning',
    }
  }

  return null
}

/**
 * Returns the error message string when a quota limit is rejected, or `null`.
 */
export function getRateLimitErrorMessage(
  limits: ClaudeAiLimits,
  model?: string,
): string | null {
  const msg = getRateLimitMessage(limits, model)
  return msg?.severity === 'error' ? msg.message : null
}

/**
 * Returns the warning message string when approaching a quota limit, or `null`.
 */
export function getRateLimitWarning(
  limits: ClaudeAiLimits,
  model?: string,
): string | null {
  const msg = getRateLimitMessage(limits, model)
  return msg?.severity === 'warning' ? msg.message : null
}

/**
 * Returns the notice displayed when a subscriber enters extra usage overage.
 */
export function getUsingOverageText(limits: ClaudeAiLimits): string | null {
  if (!limits.isUsingOverage) {
    return null
  }
  return `You're now using extra usage${formatResetTime(limits.resetsAt)}`
}
