/**
 * Rough offline token estimation and API-backed token counting (`countTokens`,
 * Bedrock `CountTokensCommand`, and Haiku/Sonnet fallback) with VCR support.
 */

import type {
  BetaMessageParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../constants/betas.js'
import type { Message } from '../types/message.js'
import { getModelBetas } from '../utilities/betas.js'
import { logError } from '../utilities/log.js'
import {
  createBedrockRuntimeClient,
  extractModelIdFromArn,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../utilities/model/bedrock.js'
import {
  getDefaultSonnetModel,
  getSmallFastModel,
  normalizeModelStringForApi,
} from '../utilities/model/model.js'
import { getApiProvider } from '../utilities/model/providers.js'
import { importOptionalModule } from '../utilities/optional_import.js'
import { jsonStringify } from '../utilities/slow_operations.js'
import { getAnthropicClient } from './api/client.js'
import { withTokenCountVcr } from './vcr.js'

export const TOKEN_COUNT_THINKING_BUDGET = 1024
export const TOKEN_COUNT_MAX_TOKENS = 2048
const MEDIA_BLOCK_FIXED_TOKEN_ESTIMATE = 2000

interface BedrockRuntimeCountTokensModule {
  CountTokensCommand: new (input: Record<string, unknown>) => unknown
}

/**
 * Returns estimated bytes per token for a file extension (`2` for JSON formats,
 * `4` for general text/code).
 */
export function bytesPerTokenForFileType(ext: string): number {
  const normalized = ext.toLowerCase().replace(/^\./, '')
  if (
    normalized === 'json' ||
    normalized === 'jsonl' ||
    normalized === 'jsonc'
  ) {
    return 2
  }
  return 4
}

/**
 * Estimates tokens from a string using `bytesPerToken` (default 4).
 */
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken = 4,
): number {
  if (!content) {
    return 0
  }
  return Math.round(content.length / bytesPerToken)
}

/**
 * Estimates tokens for file contents using extension-specific byte density.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  ext: string,
): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(ext))
}

function estimateContentBlockTokens(block: unknown): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (!block || typeof block !== 'object') {
    return 0
  }
  const record = block as Record<string, unknown>
  const type = record.type
  if (type === 'image' || type === 'document') {
    return MEDIA_BLOCK_FIXED_TOKEN_ESTIMATE
  }
  if (type === 'text' && typeof record.text === 'string') {
    return roughTokenCountEstimation(record.text)
  }
  if (type === 'thinking' && typeof record.thinking === 'string') {
    return roughTokenCountEstimation(record.thinking)
  }
  if (type === 'redacted_thinking' && typeof record.data === 'string') {
    return roughTokenCountEstimation(record.data)
  }
  if (type === 'tool_use') {
    const nameLen = typeof record.name === 'string' ? record.name.length : 0
    const inputStr =
      record.input !== undefined ? jsonStringify(record.input) : ''
    return roughTokenCountEstimation(inputStr) + Math.ceil(nameLen / 4)
  }
  if (type === 'tool_result') {
    if (typeof record.content === 'string') {
      return roughTokenCountEstimation(record.content)
    }
    if (Array.isArray(record.content)) {
      let sum = 0
      for (const nested of record.content) {
        sum += estimateContentBlockTokens(nested)
      }
      return sum
    }
    return 0
  }
  return roughTokenCountEstimation(jsonStringify(record))
}

/**
 * Roughly estimates token count for a single internal or API message.
 */
export function roughTokenCountEstimationForMessage(
  message: Message | BetaMessageParam,
): number {
  const content =
    'message' in message
      ? message.message.content
      : 'content' in message
        ? message.content
        : undefined
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  if (Array.isArray(content)) {
    let total = 0
    for (const block of content) {
      total += estimateContentBlockTokens(block)
    }
    return total
  }
  return 0
}

/**
 * Roughly estimates token count across a sequence of messages.
 */
export function roughTokenCountEstimationForMessages(
  messages: ReadonlyArray<Message | BetaMessageParam>,
): number {
  let total = 0
  for (const message of messages) {
    total += roughTokenCountEstimationForMessage(message)
  }
  return total
}

function hasThinkingBlocks(messages: readonly BetaMessageParam[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      continue
    }
    for (const block of msg.content) {
      if (
        block &&
        typeof block === 'object' &&
        (block.type === 'thinking' || block.type === 'redacted_thinking')
      ) {
        return true
      }
    }
  }
  return false
}

async function countTokensWithBedrock(
  messages: readonly BetaMessageParam[],
  tools: readonly BetaToolUnion[],
  model: string,
): Promise<number | null> {
  try {
    const [runtimeMod, client] = await Promise.all([
      importOptionalModule<BedrockRuntimeCountTokensModule>(
        '@aws-sdk/client-bedrock-runtime',
        'AWS Bedrock CountTokensCommand',
      ),
      createBedrockRuntimeClient(),
    ])

    let modelId = extractModelIdFromArn(normalizeModelStringForApi(model))
    if (!isFoundationModel(modelId)) {
      const backing = await getInferenceProfileBackingModel(modelId)
      if (backing) {
        modelId = backing
      }
    }

    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      ...(tools.length > 0 ? { tools } : {}),
    }

    const response = await client.send(
      new runtimeMod.CountTokensCommand({
        modelId,
        input: {
          invokeModel: {
            body: new TextEncoder().encode(jsonStringify(body)),
          },
        },
      }),
    )

    return typeof response.inputTokens === 'number'
      ? response.inputTokens
      : null
  } catch (error) {
    logError(error)
    return null
  }
}

/**
 * Counts tokens for API messages and tool schemas via the provider's native
 * token-counting endpoint (with VCR replay/record in tests).
 */
export async function countMessagesTokensWithApi(
  messages: readonly BetaMessageParam[],
  tools: readonly BetaToolUnion[] = [],
  model: string = getSmallFastModel(),
): Promise<number | null> {
  return withTokenCountVcr(messages, tools, async () => {
    const provider = getApiProvider()
    if (provider === 'bedrock') {
      return countTokensWithBedrock(messages, tools, model)
    }

    try {
      const client = await getAnthropicClient({
        maxRetries: 1,
        model,
        source: 'token_count',
      })
      const effectiveMessages: BetaMessageParam[] =
        messages.length > 0
          ? [...messages]
          : [{ role: 'user', content: 'foo' }]

      const rawBetas = getModelBetas(model)
      const betas =
        provider === 'vertex'
          ? rawBetas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
          : rawBetas

      const containsThinking = hasThinkingBlocks(effectiveMessages)
      const result = await client.beta.messages.countTokens({
        model: normalizeModelStringForApi(model),
        messages: effectiveMessages,
        ...(tools.length > 0 ? { tools: [...tools] } : {}),
        ...(betas.length > 0 ? { betas } : {}),
        ...(containsThinking
          ? {
              thinking: {
                type: 'enabled',
                budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
              },
            }
          : {}),
      })
      return result.input_tokens
    } catch (error) {
      logError(error)
      return null
    }
  })
}

/**
 * Counts tokens for a single text string via the API token counter.
 */
export async function countTokensWithApi(
  content: string,
  model: string = getSmallFastModel(),
): Promise<number | null> {
  return countMessagesTokensWithApi(
    [{ role: 'user', content }],
    [],
    model,
  )
}

function stripUnsupportedFallbackFields(
  messages: readonly BetaMessageParam[],
): BetaMessageParam[] {
  return messages.map(msg => {
    if (!Array.isArray(msg.content)) {
      return msg
    }
    const cleaned = msg.content.map(block => {
      if (!block || typeof block !== 'object') {
        return block
      }
      if (block.type === 'tool_use' && 'caller' in block) {
        const copy = { ...(block as unknown as Record<string, unknown>) }
        delete copy.caller
        return copy as unknown as typeof block
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return {
          ...block,
          content: block.content.filter(
            nested =>
              !(
                nested &&
                typeof nested === 'object' &&
                (nested as { type?: unknown }).type === 'tool_reference'
              ),
          ),
        }
      }
      return block
    })
    return { ...msg, content: cleaned }
  })
}

/**
 * Fallback token count via a minimal `max_tokens: 1` (or `2048` with thinking)
 * completion on Haiku (or Sonnet when required on Bedrock/Vertex).
 */
export async function countTokensViaHaikuFallback(
  messages: readonly BetaMessageParam[],
  tools: readonly BetaToolUnion[] = [],
): Promise<number | null> {
  const provider = getApiProvider()
  const cleaned = stripUnsupportedFallbackFields(messages)
  const containsThinking = hasThinkingBlocks(cleaned)
  const isVertexGlobal =
    provider === 'vertex' &&
    (process.env.CLOUD_ML_REGION ?? '').toLowerCase() === 'global'

  const model =
    isVertexGlobal ||
    ((provider === 'bedrock' || provider === 'vertex') && containsThinking)
      ? getDefaultSonnetModel()
      : getSmallFastModel()

  try {
    const client = await getAnthropicClient({
      maxRetries: 1,
      model,
      source: 'token_count_fallback',
    })
    const response = await client.beta.messages.create({
      model: normalizeModelStringForApi(model),
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      messages: cleaned.length > 0 ? cleaned : [{ role: 'user', content: 'foo' }],
      ...(tools.length > 0 ? { tools: [...tools] } : {}),
      ...(containsThinking
        ? {
            thinking: {
              type: 'enabled',
              budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
            },
          }
        : {}),
    })
    return (
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0)
    )
  } catch (error) {
    logError(error)
    return null
  }
}
