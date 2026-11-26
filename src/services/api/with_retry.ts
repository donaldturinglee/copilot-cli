/**
 * Smart API retry loop (`withRetry`):
 * - 10 exponential backoffs (500ms -> 32s cap) + 25% additive jitter & Retry-After.
 * - 401/revoked-403 OAuth token refresh & client recreation; AWS/GCP auth refresh.
 * - 400 context-overflow `max_tokens` auto-reduction down to a 3,000-token floor.
 * - 3 consecutive 529 overloaded errors throwing `FallbackTriggeredError`.
 * - Fast-mode 429/529 cooldown fallback and 400 permanent disable handling.
 * - Optional persistent unattended retry mode with 30s heartbeat yields.
 */

import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from '../../constants/query_source.js'
import type { SystemApiErrorMessage } from '../../types/message.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAiOauthTokens,
  handleOauth401Error,
  isClaudeAiSubscriber,
  isEnterpriseSubscriber,
} from '../../utilities/auth.js'
import { isAwsCredentialsProviderError } from '../../utilities/aws.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import {
  handleFastModeOverageRejection,
  handleFastModeRejectedByApi,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utilities/fast_mode.js'
import { isFeatureEnabled } from '../../utilities/feature_flags.js'
import { logError } from '../../utilities/log.js'
import { createSystemApiErrorMessage } from '../../utilities/messages.js'
import { isNonCustomOpusModel } from '../../utilities/model/model.js'
import { disableKeepAlive } from '../../utilities/proxy.js'
import { sleep } from '../../utilities/sleep.js'
import type { ThinkingConfig } from '../../utilities/thinking.js'
import { getFeatureValueCachedMayBeStale } from '../analytics/growthbook.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rate_limit_mocking.js'
import { extractConnectionErrorDetails } from './error_utils.js'

export const DEFAULT_MAX_RETRIES = 10
export const BASE_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 32_000
export const FLOOR_OUTPUT_TOKENS = 3_000
export const MAX_529_RETRIES = 3

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000
const MIN_COOLDOWN_MS = 10 * 60 * 1000
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

const CONTEXT_OVERFLOW_REGEX =
  /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/

const FOREGROUND_529_RETRY_SOURCES = new Set<string>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  'auto_mode',
])

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

export interface WithRetryOptions {
  maxRetries?: number
  model: string
  thinkingConfig: ThinkingConfig
  fallbackModel?: string
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  initialConsecutive529Errors?: number
  /** Test-only delay override to avoid real waits during unit tests. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Thrown when `withRetry` exhausts retries or encounters a non-retryable error.
 */
export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : String(originalError),
    )
    this.name = 'RetryError'
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

/**
 * Thrown after 3 consecutive HTTP 529 Overloaded errors when a `fallbackModel`
 * is configured, instructing `query()` to switch models and retry.
 */
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

/**
 * Resolves the default retry cap (`COPILOT_CLI_MAX_RETRIES` or 10).
 */
export function getDefaultMaxRetries(): number {
  const raw = process.env.COPILOT_CLI_MAX_RETRIES
  if (raw) {
    const parsed = Number(raw)
    if (!Number.isNaN(parsed) && Number.isInteger(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return DEFAULT_MAX_RETRIES
}

function readHeader(error: unknown, name: string): string | null {
  if (!error || typeof error !== 'object' || !('headers' in error)) {
    return null
  }
  const headers = (error as { headers?: unknown }).headers
  if (!headers || typeof headers !== 'object') {
    return null
  }
  if (headers instanceof Headers) {
    return headers.get(name)
  }
  const record = headers as Record<string, string | undefined>
  const direct = record[name] ?? record[name.toLowerCase()]
  if (typeof direct === 'string') {
    return direct
  }
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === name.toLowerCase() && typeof v === 'string') {
      return v
    }
  }
  return null
}

/**
 * Calculates retry wait time in ms from `Retry-After` (in seconds) or
 * exponential backoff (`500ms * 2^(attempt-1)` capped at `maxDelayMs`) + 25% jitter.
 */
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000
    }
  }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs)
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

/**
 * Parses a 400 context-overflow error (`input length and max_tokens exceed context limit`).
 */
export function parseMaxTokensContextOverflowError(
  error: APIError,
): { inputTokens: number; maxTokens: number; contextLimit: number } | undefined {
  if (error.status !== 400) {
    return undefined
  }
  if (
    !error.message?.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }
  const match = error.message.match(CONTEXT_OVERFLOW_REGEX)
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined
  }
  const inputTokens = Number(match[1])
  const maxTokens = Number(match[2])
  const contextLimit = Number(match[3])
  if (
    Number.isNaN(inputTokens) ||
    Number.isNaN(maxTokens) ||
    Number.isNaN(contextLimit)
  ) {
    return undefined
  }
  return { inputTokens, maxTokens, contextLimit }
}

/**
 * Returns true if `error` represents an Anthropic 529 / `overloaded_error`.
 */
export function is529Error(error: unknown): boolean {
  if (error instanceof APIError) {
    return (
      error.status === 529 ||
      Boolean(error.message?.includes('"type":"overloaded_error"'))
    )
  }
  if (error && typeof error === 'object') {
    const rec = error as { status?: unknown; message?: unknown }
    return (
      rec.status === 529 ||
      (typeof rec.message === 'string' &&
        rec.message.includes('"type":"overloaded_error"'))
    )
  }
  return false
}

function isOauthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    Boolean(error.message?.includes('OAuth token has been revoked'))
  )
}

function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('Could not load the default credentials') ||
    error.message.includes('Could not refresh access token') ||
    error.message.includes('invalid_grant')
  )
}

function isBedrockAuthError(error: unknown): boolean {
  if (!isEnvTruthy(process.env.COPILOT_CLI_USE_BEDROCK)) {
    return false
  }
  return (
    isAwsCredentialsProviderError(error) ||
    (error instanceof APIError && error.status === 403)
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (!isEnvTruthy(process.env.COPILOT_CLI_USE_VERTEX)) {
    return false
  }
  return (
    isGoogleAuthLibraryCredentialError(error) ||
    (error instanceof APIError && error.status === 401)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const code = extractConnectionErrorDetails(error)?.code
  return code === 'ECONNRESET' || code === 'EPIPE'
}

function isPersistentRetryEnabled(): boolean {
  return (
    isFeatureEnabled('UNATTENDED_RETRY') &&
    isEnvTruthy(process.env.COPILOT_CLI_UNATTENDED_RETRY)
  )
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function shouldRetry529(querySource?: QuerySource): boolean {
  if (!querySource) {
    return true
  }
  if (FOREGROUND_529_RETRY_SOURCES.has(querySource)) {
    return true
  }
  if (querySource.startsWith('agent:builtin:')) {
    return true
  }
  if (querySource === 'bash_classifier' && isFeatureEnabled('TRANSCRIPT_CLASSIFIER')) {
    return true
  }
  return false
}

function shouldRetry(error: APIError): boolean {
  if (isMockRateLimitError(error)) {
    return false
  }
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }
  if (
    isEnvTruthy(process.env.COPILOT_CLI_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  const xShouldRetry = readHeader(error, 'x-should-retry')
  if (
    xShouldRetry === 'true' &&
    (!isClaudeAiSubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }
  if (xShouldRetry === 'false') {
    return (
      process.env.USER_TYPE === 'ant' &&
      error.status !== undefined &&
      error.status >= 500
    )
  }

  if (error instanceof APIConnectionError) {
    return true
  }
  if (!error.status) {
    return false
  }
  if (error.status === 408 || error.status === 409) {
    return true
  }
  if (error.status === 429) {
    return !isClaudeAiSubscriber() || isEnterpriseSubscriber()
  }
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }
  if (isOauthTokenRevokedError(error)) {
    return true
  }
  if (error.status >= 500) {
    return true
  }
  return false
}

function getRateLimitResetDelayMs(error: unknown): number | null {
  const raw = readHeader(error, 'anthropic-ratelimit-unified-reset')
  if (!raw) return null
  const resetUnixSec = Number(raw)
  if (Number.isNaN(resetUnixSec) || resetUnixSec <= 0) {
    return null
  }
  const deltaMs = resetUnixSec * 1000 - Date.now()
  if (deltaMs <= 0) return null
  return Math.min(deltaMs, PERSISTENT_RESET_CAP_MS)
}

/**
 * Executes an API operation with full exponential backoff, OAuth/cloud
 * credential refresh, context-overflow max_tokens reduction, 529 fallback
 * switching, and fast-mode cooldown handling.
 */
export async function* withRetry<Result>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    retryContext: RetryContext,
  ) => Promise<Result>,
  options: WithRetryOptions,
): AsyncGenerator<SystemApiErrorMessage, Result> {
  const maxRetries = options.maxRetries ?? getDefaultMaxRetries()
  const doSleep =
    options.sleepFn ??
    ((ms: number, signal?: AbortSignal) =>
      sleep(ms, signal, { abortError: () => new APIUserAbortError() }))

  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    fastMode: options.fastMode,
  }

  let client: Anthropic | null = null
  let lastError: unknown = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let persistentAttempt = 0

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    const wasFastModeActive = isFastModeEnabled()
      ? Boolean(retryContext.fastMode && !isFastModeCooldown())
      : false

    if (process.env.USER_TYPE === 'ant' || process.env.NODE_ENV === 'test') {
      const mockError = checkMockRateLimitError(
        retryContext.model,
        wasFastModeActive,
      )
      if (mockError) {
        throw new CannotRetryError(mockError, retryContext)
      }
    }

    const staleConn = isStaleConnectionError(lastError)
    if (
      staleConn &&
      getFeatureValueCachedMayBeStale('tengu_disable_keepalive_on_econnreset', false)
    ) {
      disableKeepAlive()
    }

    const is401 = lastError instanceof APIError && lastError.status === 401
    const isRevoked403 = isOauthTokenRevokedError(lastError)
    const shouldRecreateClient =
      client === null ||
      is401 ||
      isRevoked403 ||
      isBedrockAuthError(lastError) ||
      isVertexAuthError(lastError) ||
      staleConn

    if (is401 || isRevoked403) {
      const failedAccessToken = getClaudeAiOauthTokens()?.accessToken
      if (failedAccessToken) {
        await handleOauth401Error(failedAccessToken)
      }
    }

    if (shouldRecreateClient) {
      client = await getClient()
    }

    try {
      return await operation(client!, attempt, retryContext)
    } catch (error) {
      lastError = error

      if (error instanceof APIUserAbortError || options.signal?.aborted) {
        throw error
      }

      // (a) Fast-mode 429/529 cooldown fallback
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        const overageReason = readHeader(
          error,
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterRaw = readHeader(error, 'retry-after')
        const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN
        const retryAfterMs =
          !Number.isNaN(retryAfterSec) && retryAfterSec >= 0
            ? retryAfterSec * 1000
            : null

        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          await doSleep(retryAfterMs, options.signal)
          continue
        }

        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        triggerFastModeCooldown(
          Date.now() + cooldownMs,
          is529Error(error) ? 'overloaded' : 'rate_limit',
        )
        retryContext.fastMode = false
        continue
      }

      // (b) Fast-mode 400 permanent disable
      if (
        wasFastModeActive &&
        error instanceof APIError &&
        error.status === 400 &&
        error.message?.includes('Fast mode is not enabled')
      ) {
        handleFastModeRejectedByApi()
        retryContext.fastMode = false
        continue
      }

      // (c) Background 529 drop
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          querySource: (options.querySource ??
            'unknown') as VerifiedNonSensitiveAnalyticsMetadata,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // (d) Consecutive 529 fallback tracking (3 consecutive 529s)
      if (
        is529Error(error) &&
        (isEnvTruthy(process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS) ||
          (!isClaudeAiSubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as VerifiedNonSensitiveAnalyticsMetadata,
              fallback_model:
                options.fallbackModel as VerifiedNonSensitiveAnalyticsMetadata,
            })
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }
          if (
            process.env.USER_TYPE !== 'ant' &&
            process.env.IS_SANDBOX !== '1' &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {
              model: options.model as VerifiedNonSensitiveAnalyticsMetadata,
            })
            throw new CannotRetryError(
              new Error('Repeated 529 Overloaded errors'),
              retryContext,
            )
          }
        }
      } else {
        consecutive529Errors = 0
      }

      // (e) Attempt exhaustion
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      // (f) Retryability gate (AWS/GCP credential cache reset + shouldRetry)
      let handledCloudAuth = false
      if (isBedrockAuthError(error)) {
        clearAwsCredentialsCache()
        handledCloudAuth = true
      } else if (isVertexAuthError(error)) {
        clearGcpCredentialsCache()
        handledCloudAuth = true
      }

      if (!handledCloudAuth) {
        if (!(error instanceof APIError) || !shouldRetry(error)) {
          throw new CannotRetryError(error, retryContext)
        }
      }

      // (g) 400 context-overflow max_tokens reduction down to 3,000 floor
      if (error instanceof APIError) {
        const overflow = parseMaxTokensContextOverflowError(error)
        if (overflow) {
          const safetyBuffer = 1_000
          const availableContext = Math.max(
            0,
            overflow.contextLimit - overflow.inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(error)
            throw error
          }
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens
          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens: overflow.inputTokens,
            originalMaxTokens: overflow.maxTokens,
            contextLimit: overflow.contextLimit,
            adjustedMaxTokens,
          })
          continue
        }
      }

      // (h) Backoff delay + heartbeat yield + sleep
      const retryAfter = readHeader(error, 'retry-after')
      let delayMs: number

      if (persistent) {
        persistentAttempt++
        if (error instanceof APIError && error.status === 429) {
          delayMs =
            getRateLimitResetDelayMs(error) ??
            Math.min(
              getRetryDelay(
                persistentAttempt,
                retryAfter,
                PERSISTENT_MAX_BACKOFF_MS,
              ),
              PERSISTENT_RESET_CAP_MS,
            )
        } else {
          delayMs = Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
        }

        logEvent('tengu_api_retry', {
          attempt: persistentAttempt,
          delayMs,
          persistent: true,
        })

        let remaining = delayMs
        while (remaining > 0) {
          const slice = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          if (error instanceof APIError) {
            yield createSystemApiErrorMessage(
              error,
              remaining,
              persistentAttempt,
              maxRetries,
            )
          }
          await doSleep(slice, options.signal)
          remaining -= slice
        }
        if (attempt >= maxRetries) {
          attempt = maxRetries
        }
        continue
      }

      delayMs = getRetryDelay(attempt, retryAfter)
      logEvent('tengu_api_retry', {
        attempt,
        delayMs,
        status: error instanceof APIError ? (error.status ?? 0) : 0,
      })

      if (error instanceof APIError) {
        yield createSystemApiErrorMessage(error, delayMs, attempt, maxRetries)
      }
      await doSleep(delayMs, options.signal)
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}
