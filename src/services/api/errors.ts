/**
 * Comprehensive Anthropic & 3P API error classification, prompt-too-long
 * parsing, refusal detection, and user-facing `AssistantMessage` mapping.
 */

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { SdkAssistantMessageError } from '../../types/forward.js'
import type { AssistantMessage } from '../../types/message.js'
import { isClaudeAiSubscriber } from '../../utilities/auth.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import {
  createAssistantApiErrorMessage,
  ImageResizeError,
  ImageSizeError,
} from '../../utilities/messages.js'
import { getModelStrings } from '../../utilities/model/model_strings.js'
import { getApiProvider } from '../../utilities/model/providers.js'
import {
  extractQuotaStatusFromError,
  getCurrentLimits,
  getRateLimitErrorMessage,
} from '../claude_ai_limits.js'
import { shouldProcessRateLimits } from '../rate_limit_mocking.js'
import {
  extractConnectionErrorDetails,
  formatApiError,
  SSL_ERROR_CODES,
} from './error_utils.js'

export const API_ERROR_MESSAGE_PREFIX = 'API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE =
  'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE =
  'Invalid API key · Please run /login'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  'Invalid API key · Fix external API key'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY =
  'Your organization has been disabled. Check your ANTHROPIC_API_KEY environment variable.'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH =
  'Your organization has been disabled. Unset ANTHROPIC_API_KEY to use your Claude.ai login.'
export const TOKEN_REVOKED_ERROR_MESSAGE =
  'OAuth token has been revoked · Please run /login'
export const CCR_AUTH_ERROR_MESSAGE =
  'Authentication failed in remote environment. Please refresh your session credentials.'
export const REPEATED_529_ERROR_MESSAGE =
  'API Error: Repeated 529 Overloaded errors. Please try again shortly.'
export const CUSTOM_OFF_SWITCH_MESSAGE =
  'Opus is experiencing high load, please use /model to switch to Sonnet'
export const API_TIMEOUT_ERROR_MESSAGE =
  'API Error: Request timed out. Please try again.'
export const OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE =
  'Your organization is not permitted to use Copilot CLI.'

const PROMPT_TOO_LONG_COUNT_REGEX =
  /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i

/**
 * Returns true if `text` starts with `"API Error"`.
 */
export function startsWithApiErrorPrefix(text: string): boolean {
  return text.startsWith(API_ERROR_MESSAGE_PREFIX)
}

/**
 * Returns true if `text` indicates a prompt-too-long error.
 */
export function isPromptTooLongMessage(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('prompt is too long') ||
    lower.includes('input is too long') ||
    lower.includes('exceeds the maximum context length')
  )
}

/**
 * Parses actual vs limit token counts from a prompt-too-long error string.
 */
export function parsePromptTooLongTokenCounts(
  text: string,
): { actualTokens: number; maxTokens: number } | null {
  const match = text.match(PROMPT_TOO_LONG_COUNT_REGEX)
  if (!match?.[1] || !match[2]) {
    return null
  }
  const actualTokens = Number(match[1])
  const maxTokens = Number(match[2])
  if (Number.isNaN(actualTokens) || Number.isNaN(maxTokens)) {
    return null
  }
  return { actualTokens, maxTokens }
}

/**
 * Returns the excess token gap (`actualTokens - maxTokens`) for a prompt-too-long error.
 */
export function getPromptTooLongTokenGap(text: string): number | null {
  const counts = parsePromptTooLongTokenCounts(text)
  if (!counts) return null
  return Math.max(0, counts.actualTokens - counts.maxTokens)
}

/**
 * Returns true if an error message relates to oversized/unsupported image or PDF media.
 */
export function isMediaSizeErrorMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('image exceeds') ||
    lower.includes('pdf') ||
    lower.includes('request_too_large') ||
    lower.includes('maximum image size')
  )
}

/**
 * Returns true if `error` is a media-size or image-resize failure.
 */
export function isMediaSizeError(error: unknown): boolean {
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return true
  }
  if (error instanceof APIError && (error.status === 413 || error.status === 400)) {
    return isMediaSizeErrorMessage(error.message)
  }
  return false
}

/**
 * Extracts Amazon Bedrock `Output.__type` error identifiers when present.
 */
export function extractUnknownErrorFormat(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const record = error as {
    error?: { Output?: { __type?: unknown }; message?: unknown }
  }
  if (typeof record.error?.Output?.__type === 'string') {
    return record.error.Output.__type
  }
  return undefined
}

/**
 * Returns true if an error carries a recognizable API error structure.
 */
export function isValidApiMessage(error: unknown): boolean {
  return error instanceof APIError || extractUnknownErrorFormat(error) !== undefined
}

/**
 * Maps an API error to a coarse analytics classification tag.
 */
export function classifyApiError(error: unknown): string {
  if (error instanceof APIUserAbortError) {
    return 'aborted'
  }
  if (error instanceof APIConnectionTimeoutError) {
    return 'api_timeout'
  }
  if (error instanceof Error && error.message.includes('Repeated 529')) {
    return 'repeated_529'
  }
  if (error instanceof Error && error.message === CUSTOM_OFF_SWITCH_MESSAGE) {
    return 'capacity_off_switch'
  }
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return 'image_too_large'
  }

  const connDetails = extractConnectionErrorDetails(error)
  if (connDetails?.code && SSL_ERROR_CODES.has(connDetails.code)) {
    return 'ssl_cert_error'
  }
  if (error instanceof APIConnectionError) {
    return 'connection_error'
  }

  if (error instanceof APIError) {
    const msg = error.message ?? ''
    const lower = msg.toLowerCase()
    if (error.status === 429) return 'rate_limit'
    if (error.status === 529 || lower.includes('overloaded_error')) {
      return 'server_overload'
    }
    if (isPromptTooLongMessage(msg)) return 'prompt_too_long'
    if (lower.includes('pdf') && lower.includes('password')) {
      return 'pdf_password_protected'
    }
    if (lower.includes('pdf') && (lower.includes('too large') || error.status === 413)) {
      return 'pdf_too_large'
    }
    if (lower.includes('image') && (lower.includes('too large') || lower.includes('exceeds'))) {
      return 'image_too_large'
    }
    if (lower.includes('tool_use') && lower.includes('without `tool_result`')) {
      return 'tool_use_mismatch'
    }
    if (lower.includes('unexpected `tool_use_id`')) {
      return 'unexpected_tool_result'
    }
    if (lower.includes('duplicate') && lower.includes('tool_use')) {
      return 'duplicate_tool_use_id'
    }
    if (error.status === 404 && lower.includes('model')) {
      return 'invalid_model'
    }
    if (lower.includes('credit balance is too low')) {
      return 'credit_balance_low'
    }
    if (lower.includes('invalid x-api-key')) {
      return 'invalid_api_key'
    }
    if (lower.includes('oauth token has been revoked')) {
      return 'token_revoked'
    }
    if (error.status === 403 && lower.includes('organization')) {
      return 'oauth_org_not_allowed'
    }
    if (error.status === 401 || error.status === 403) {
      return getApiProvider() === 'bedrock'
        ? 'bedrock_model_access'
        : 'auth_error'
    }
    if (error.status !== undefined && error.status >= 500) {
      return 'server_error'
    }
    if (error.status !== undefined && error.status >= 400) {
      return 'client_error'
    }
  }

  return 'unknown'
}

/**
 * Maps a retryable API error to an external `SdkAssistantMessageError` enum value.
 */
export function categorizeRetryableApiError(
  error: unknown,
): SdkAssistantMessageError {
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) {
      return 'authentication_failed'
    }
    if (error.status === 429) {
      return 'rate_limit'
    }
    if (
      error.status === 400 &&
      error.message.toLowerCase().includes('credit balance')
    ) {
      return 'billing_error'
    }
    if (error.status !== undefined && error.status >= 400 && error.status < 500) {
      return 'invalid_request'
    }
    if (error.status !== undefined && error.status >= 500) {
      return 'server_error'
    }
  }
  return 'unknown'
}

/**
 * Returns an assistant error message if `stopReason === 'refusal'`, else `null`.
 */
export function getErrorMessageIfRefusal(
  stopReason: string | null | undefined,
  model: string,
): AssistantMessage | null {
  if (stopReason !== 'refusal') {
    return null
  }
  return createAssistantApiErrorMessage({
    content: `${API_ERROR_MESSAGE_PREFIX}: ${model} was unable to respond to this request (refusal).`,
    error: 'invalid_request',
  })
}

function get3pFallbackSuggestion(model: string): string | null {
  if (getApiProvider() === 'firstParty') {
    return null
  }
  const lower = model.toLowerCase()
  const strings = getModelStrings()
  if (lower.includes('opus-4-6')) {
    return strings.opus41
  }
  if (lower.includes('sonnet-4-6')) {
    return strings.sonnet45
  }
  if (lower.includes('sonnet-4-5')) {
    return strings.sonnet40
  }
  return null
}

/**
 * Converts any thrown API/network/media error into a structured user-facing
 * `AssistantMessage` (`isApiErrorMessage: true`).
 */
export function getAssistantMessageFromError(
  error: unknown,
  model: string,
): AssistantMessage {
  if (error instanceof APIConnectionTimeoutError) {
    return createAssistantApiErrorMessage({
      content: API_TIMEOUT_ERROR_MESSAGE,
      error: 'server_error',
    })
  }

  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantApiErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'invalid_request',
    })
  }

  if (error instanceof APIError) {
    const rawMsg = error.message ?? ''
    const lower = rawMsg.toLowerCase()

    if (error.status === 429) {
      extractQuotaStatusFromError(error)
      if (shouldProcessRateLimits(isClaudeAiSubscriber())) {
        const rateLimitMsg = getRateLimitErrorMessage(getCurrentLimits(), model)
        if (rateLimitMsg) {
          return createAssistantApiErrorMessage({
            content: rateLimitMsg,
            error: 'rate_limit',
          })
        }
      }
      return createAssistantApiErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: Rate limit reached (${formatApiError(error)})`,
        error: 'rate_limit',
      })
    }

    if (isPromptTooLongMessage(rawMsg) || error.status === 413) {
      return createAssistantApiErrorMessage({
        content: PROMPT_TOO_LONG_ERROR_MESSAGE,
        error: 'invalid_request',
      })
    }

    if (lower.includes('credit balance is too low')) {
      return createAssistantApiErrorMessage({
        content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
        error: 'billing_error',
      })
    }

    if (lower.includes('oauth token has been revoked')) {
      return createAssistantApiErrorMessage({
        content: TOKEN_REVOKED_ERROR_MESSAGE,
        error: 'authentication_failed',
      })
    }

    if (error.status === 401 || error.status === 403) {
      if (isEnvTruthy(process.env.COPILOT_CLI_REMOTE)) {
        return createAssistantApiErrorMessage({
          content: CCR_AUTH_ERROR_MESSAGE,
          error: 'authentication_failed',
        })
      }
      if (lower.includes('invalid x-api-key')) {
        return createAssistantApiErrorMessage({
          content: process.env.ANTHROPIC_API_KEY
            ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL
            : INVALID_API_KEY_ERROR_MESSAGE,
          error: 'authentication_failed',
        })
      }
      if (error.status === 403 && lower.includes('organization')) {
        return createAssistantApiErrorMessage({
          content: OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE,
          error: 'authentication_failed',
        })
      }
      return createAssistantApiErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: Authentication failed (${formatApiError(error)})`,
        error: 'authentication_failed',
      })
    }

    if (error.status === 400 && lower.includes('organization has been disabled')) {
      return createAssistantApiErrorMessage({
        content: isClaudeAiSubscriber()
          ? ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH
          : ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
        error: 'billing_error',
      })
    }

    if (error.status === 404) {
      const suggestion = get3pFallbackSuggestion(model)
      const hint = suggestion
        ? ` Try switching to ${suggestion} with --model.`
        : ''
      return createAssistantApiErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: 404 Model "${model}" not found.${hint}`,
        error: 'invalid_request',
      })
    }

    if (error.status !== undefined && error.status >= 500) {
      return createAssistantApiErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: ${error.status} ${formatApiError(error)}`,
        error: 'server_error',
      })
    }

    return createAssistantApiErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.status ?? ''} ${formatApiError(error)}`.trim(),
      error: categorizeRetryableApiError(error),
    })
  }

  if (error instanceof Error && error.message.includes('Repeated 529')) {
    return createAssistantApiErrorMessage({
      content: REPEATED_529_ERROR_MESSAGE,
      error: 'server_error',
    })
  }

  return createAssistantApiErrorMessage({
    content: `${API_ERROR_MESSAGE_PREFIX}: ${formatApiError(error)}`,
    error: 'unknown',
  })
}
