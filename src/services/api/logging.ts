/**
 * Structured API request/success/error analytics, gateway fingerprinting,
 * OTel event logging, and duration/completion state updates.
 */

import {
  addToTotalDurationState,
  setLastApiCompletionTimestamp,
} from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/query_source.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../analytics/index.js'
import { logForDebugging } from '../../utilities/debug.js'
import { logOtelEvent } from '../../utilities/telemetry/events.js'
import {
  accumulateUsage,
  EMPTY_USAGE,
  type NonNullableUsage,
  updateUsage,
} from './empty_usage.js'

export { accumulateUsage, EMPTY_USAGE, updateUsage, type NonNullableUsage }

export type GlobalCacheStrategy = 'system_prompt' | 'tool_based' | 'none'

const GATEWAY_FINGERPRINTS: ReadonlyArray<[string, string]> = [
  ['x-litellm-', 'litellm'],
  ['helicone-', 'helicone'],
  ['x-portkey-', 'portkey'],
  ['cf-aig-', 'cloudflare_ai_gateway'],
  ['x-kong-', 'kong'],
  ['x-bt-', 'braintrust'],
]

const GATEWAY_HOST_SUFFIXES: ReadonlyArray<[string, string]> = [
  ['.cloud.databricks.com', 'databricks'],
  ['.azuredatabricks.net', 'databricks'],
  ['.gcp.databricks.com', 'databricks'],
]

/**
 * Identifies third-party LLM gateways from response headers and `ANTHROPIC_BASE_URL`.
 */
export function detectApiGateway(
  headers?: Headers | Record<string, string | undefined> | null,
  baseUrl: string | undefined = process.env.ANTHROPIC_BASE_URL,
): string | undefined {
  if (headers) {
    const keys: string[] = []
    if (headers instanceof Headers) {
      headers.forEach((_value, key) => {
        keys.push(key)
      })
    } else {
      keys.push(...Object.keys(headers))
    }
    for (const key of keys) {
      const lower = key.toLowerCase()
      for (const [prefix, gatewayName] of GATEWAY_FINGERPRINTS) {
        if (lower.startsWith(prefix)) {
          return gatewayName
        }
      }
    }
  }
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase()
      for (const [suffix, gatewayName] of GATEWAY_HOST_SUFFIXES) {
        if (host.endsWith(suffix)) {
          return gatewayName
        }
      }
    } catch {
      // Ignore invalid base URL
    }
  }
  return undefined
}

/**
 * Logs initiation of an LLM API query.
 */
export function logApiQuery(params: {
  model: string
  messagesLength: number
  temperature?: number
  betas?: readonly string[]
  querySource?: QuerySource
  globalCacheStrategy?: GlobalCacheStrategy
  agentId?: string
}): void {
  logEvent('tengu_api_query', {
    model: params.model as VerifiedNonSensitiveAnalyticsMetadata,
    messagesLength: params.messagesLength,
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.betas && params.betas.length > 0
      ? {
          betas: params.betas.join(
            ',',
          ) as VerifiedNonSensitiveAnalyticsMetadata,
        }
      : {}),
    ...(params.querySource
      ? { querySource: params.querySource as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    ...(params.globalCacheStrategy
      ? {
          globalCacheStrategy:
            params.globalCacheStrategy as VerifiedNonSensitiveAnalyticsMetadata,
        }
      : {}),
  })
}

/**
 * Logs an LLM API error to analytics, debug logs, and OpenTelemetry.
 */
export function logApiError(params: {
  errorMessage: string
  errorType?: string
  statusCode?: number | string
  model: string
  durationMs: number
  attempt?: number
  querySource?: QuerySource
  requestId?: string
}): void {
  logForDebugging(
    `API error (${params.model}, status=${params.statusCode ?? 'unknown'}): ${params.errorMessage}`,
    { level: 'error' },
  )
  logEvent('tengu_api_error', {
    model: params.model as VerifiedNonSensitiveAnalyticsMetadata,
    error: (params.errorType ?? 'unknown') as VerifiedNonSensitiveAnalyticsMetadata,
    status: String(params.statusCode ?? '') as VerifiedNonSensitiveAnalyticsMetadata,
    durationMs: params.durationMs,
    ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
    ...(params.querySource
      ? { querySource: params.querySource as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    ...(params.requestId
      ? { requestId: params.requestId as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
  })
  void logOtelEvent('api_error', {
    model: params.model,
    error: params.errorType ?? 'unknown',
    status_code:
      params.statusCode !== undefined ? String(params.statusCode) : undefined,
    duration_ms: String(params.durationMs),
    attempt: params.attempt !== undefined ? String(params.attempt) : undefined,
  })
}

/**
 * Records API call duration, completion timestamp, analytics event, and OTel
 * `api_request` event after a successful response.
 */
export function logApiSuccessAndDuration(params: {
  model: string
  costUsd: number
  durationMs: number
  durationMsIncludingRetries: number
  usage: NonNullableUsage
  ttftMs?: number
  stopReason?: string | null
  requestId?: string
  querySource?: QuerySource
  responseHeaders?: Headers | null
  fastMode?: boolean
}): void {
  addToTotalDurationState(params.durationMsIncludingRetries, params.durationMs)
  setLastApiCompletionTimestamp(Date.now())

  const gateway = detectApiGateway(params.responseHeaders)

  logEvent('tengu_api_success', {
    model: params.model as VerifiedNonSensitiveAnalyticsMetadata,
    inputTokens: params.usage.input_tokens,
    outputTokens: params.usage.output_tokens,
    cachedInputTokens: params.usage.cache_read_input_tokens,
    uncachedInputTokens: params.usage.cache_creation_input_tokens,
    durationMs: params.durationMs,
    durationMsIncludingRetries: params.durationMsIncludingRetries,
    costUSD: params.costUsd,
    ...(params.ttftMs !== undefined ? { ttftMs: params.ttftMs } : {}),
    ...(params.stopReason
      ? { stop_reason: params.stopReason as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    ...(params.requestId
      ? { requestId: params.requestId as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    ...(params.querySource
      ? { querySource: params.querySource as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    ...(gateway
      ? { gateway: gateway as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    ...(params.fastMode ? { speed: 'fast' as VerifiedNonSensitiveAnalyticsMetadata } : {}),
  })

  void logOtelEvent('api_request', {
    model: params.model,
    cost_usd: String(params.costUsd),
    duration_ms: String(params.durationMsIncludingRetries),
    input_tokens: String(params.usage.input_tokens),
    output_tokens: String(params.usage.output_tokens),
    cache_read_tokens: String(params.usage.cache_read_input_tokens),
    cache_creation_tokens: String(params.usage.cache_creation_input_tokens),
    ...(params.fastMode ? { speed: 'fast' } : {}),
  })
}
