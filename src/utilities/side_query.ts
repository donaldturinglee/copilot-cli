/**
 * Lightweight single-turn non-streaming side query (`sideQuery`) with full
 * billing fingerprint attribution, CLI system prefix, model betas, and metrics.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaTextBlockParam,
  BetaToolChoice,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import type { QuerySource } from '../constants/query_source.js'
import {
  getAttributionHeader,
  getCliSyspromptPrefix,
} from '../constants/system.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'
import {
  getApiMetadata,
  type JsonOutputFormat,
} from '../services/api/claude.js'
import { getAnthropicClient } from '../services/api/client.js'
import {
  getModelBetas,
  modelSupportsStructuredOutputs,
} from './betas.js'
import { computeFingerprint } from './fingerprint.js'
import { normalizeModelStringForApi } from './model/model.js'

export interface SideQueryOptions {
  model: string
  system?: string | BetaTextBlockParam[]
  messages: MessageParam[]
  tools?: BetaToolUnion[]
  toolChoice?: BetaToolChoice
  outputFormat?: JsonOutputFormat
  maxTokens?: number
  maxRetries?: number
  signal?: AbortSignal
  skipSystemPromptPrefix?: boolean
  temperature?: number
  thinking?: number | false
  stopSequences?: string[]
  querySource: QuerySource
  /** Test-only client factory override. */
  clientFactoryOverride?: () => Promise<Anthropic>
}

function extractFirstUserMessageText(messages: readonly MessageParam[]): string {
  const firstUser = messages.find(m => m.role === 'user')
  if (!firstUser) return ''
  if (typeof firstUser.content === 'string') {
    return firstUser.content
  }
  if (Array.isArray(firstUser.content)) {
    const firstText = firstUser.content.find(block => block.type === 'text')
    if (firstText && firstText.type === 'text') {
      return firstText.text
    }
  }
  return ''
}

/**
 * Executes a single lightweight non-streaming API completion outside the main
 * turn loop (used for model validation, classifiers, titles, and summaries).
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  const startTime = Date.now()
  const maxTokens = opts.maxTokens ?? 1024
  const maxRetries = opts.maxRetries ?? 2

  const client = opts.clientFactoryOverride
    ? await opts.clientFactoryOverride()
    : await getAnthropicClient({
        maxRetries,
        model: opts.model,
        source: 'side_query',
      })

  const betas = [...getModelBetas(opts.model)]
  if (
    opts.outputFormat &&
    modelSupportsStructuredOutputs(opts.model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  const firstText = extractFirstUserMessageText(opts.messages)
  const fingerprint = computeFingerprint(firstText)
  const attributionHeader = getAttributionHeader(fingerprint)

  const systemBlocks: BetaTextBlockParam[] = []
  if (attributionHeader) {
    // Attribution header must occupy its own first block for server parsing
    systemBlocks.push({ type: 'text', text: attributionHeader })
  }
  if (!opts.skipSystemPromptPrefix) {
    systemBlocks.push({
      type: 'text',
      text: getCliSyspromptPrefix({
        isNonInteractive: false,
        hasAppendSystemPrompt: false,
      }),
    })
  }
  if (typeof opts.system === 'string' && opts.system.length > 0) {
    systemBlocks.push({ type: 'text', text: opts.system })
  } else if (Array.isArray(opts.system)) {
    systemBlocks.push(...opts.system)
  }

  const thinkingConfig =
    typeof opts.thinking === 'number'
      ? {
          type: 'enabled' as const,
          budget_tokens: Math.min(opts.thinking, Math.max(1024, maxTokens - 1)),
        }
      : opts.thinking === false
        ? { type: 'disabled' as const }
        : undefined

  const normalizedModel = normalizeModelStringForApi(opts.model)
  const requestBody: Record<string, unknown> = {
    model: normalizedModel,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: opts.messages,
    metadata: getApiMetadata(),
    ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
    ...(opts.outputFormat
      ? { output_config: { format: opts.outputFormat } }
      : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.stopSequences ? { stop_sequences: opts.stopSequences } : {}),
    ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
    ...(betas.length > 0 ? { betas } : {}),
  }

  const { data: response, request_id: requestId } = await client.beta.messages
    .create(
      requestBody as unknown as Parameters<typeof client.beta.messages.create>[0],
      { signal: opts.signal },
    )
    .withResponse()

  const now = Date.now()
  const prevCompletion = getLastApiCompletionTimestamp()
  setLastApiCompletionTimestamp(now)

  const betaResponse = response as BetaMessage
  logEvent('tengu_api_success', {
    ...(requestId
      ? { requestId: requestId as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    querySource: opts.querySource as VerifiedNonSensitiveAnalyticsMetadata,
    model: opts.model as VerifiedNonSensitiveAnalyticsMetadata,
    inputTokens: betaResponse.usage.input_tokens,
    outputTokens: betaResponse.usage.output_tokens,
    cachedInputTokens: betaResponse.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: betaResponse.usage.cache_creation_input_tokens ?? 0,
    durationMsIncludingRetries: now - startTime,
    ...(prevCompletion !== null
      ? { timeSinceLastApiCallMs: now - prevCompletion }
      : {}),
  })

  return betaResponse
}
