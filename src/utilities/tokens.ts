/**
 * Token extraction and combined actual + estimated context-size helpers for
 * conversation message histories.
 */

import type { AssistantMessage, Message } from '../types/message.js'
import { roughTokenCountEstimationForMessages } from '../services/token_estimation.js'
import { jsonStringify } from './slow_operations.js'

const LARGE_CONTEXT_THRESHOLD_TOKENS = 200_000

export interface UsageWithCache {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  iterations?: ReadonlyArray<Record<string, unknown>>
}

/**
 * Computes total context tokens (input + cache creation + cache read + output)
 * from an API usage payload.
 */
export function getTokenCountFromUsage(usage: UsageWithCache): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

function getLastUsageBearingAssistant(
  messages: readonly Message[],
): { index: number; message: AssistantMessage; usage: UsageWithCache } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (
      msg &&
      msg.type === 'assistant' &&
      msg.message.model !== '<synthetic>' &&
      msg.message.usage
    ) {
      return {
        index: i,
        message: msg,
        usage: msg.message.usage as unknown as UsageWithCache,
      }
    }
  }
  return null
}

/**
 * Returns the most recent API response's usage payload, or `undefined`.
 */
export function getCurrentUsage(
  messages: readonly Message[],
): UsageWithCache | undefined {
  return getLastUsageBearingAssistant(messages)?.usage
}

/**
 * Returns the total context token count from the most recent API response.
 */
export function tokenCountFromLastApiResponse(
  messages: readonly Message[],
): number {
  const last = getLastUsageBearingAssistant(messages)
  return last ? getTokenCountFromUsage(last.usage) : 0
}

/**
 * Returns the output token count from the most recent API response.
 */
export function messageTokenCountFromLastApiResponse(
  messages: readonly Message[],
): number {
  const last = getLastUsageBearingAssistant(messages)
  return last ? last.usage.output_tokens : 0
}

/**
 * Returns the final iteration's non-cached context tokens (`input + output`)
 * for task-budget accounting across compactions.
 */
export function finalContextTokensFromLastResponse(
  messages: readonly Message[],
): number {
  const last = getLastUsageBearingAssistant(messages)
  if (!last) {
    return 0
  }
  const iterations = last.usage.iterations
  if (Array.isArray(iterations) && iterations.length > 0) {
    const finalIter = iterations.at(-1)
    if (
      finalIter &&
      typeof finalIter.input_tokens === 'number' &&
      typeof finalIter.output_tokens === 'number'
    ) {
      return finalIter.input_tokens + finalIter.output_tokens
    }
  }
  return last.usage.input_tokens + last.usage.output_tokens
}

/**
 * Returns true if the most recent API response exceeded 200k context tokens.
 */
export function doesMostRecentAssistantMessageExceed200k(
  messages: readonly Message[],
): boolean {
  return tokenCountFromLastApiResponse(messages) > LARGE_CONTEXT_THRESHOLD_TOKENS
}

/**
 * Computes total character length across text, thinking, redacted_thinking,
 * and serialized tool_use inputs in an assistant message.
 */
export function getAssistantMessageContentLength(
  message: AssistantMessage,
): number {
  let length = 0
  for (const block of message.message.content) {
    if (block.type === 'text') {
      length += block.text.length
    } else if (block.type === 'thinking') {
      length += block.thinking.length
    } else if (block.type === 'redacted_thinking') {
      length += block.data.length
    } else if (block.type === 'tool_use') {
      length += jsonStringify(block.input).length
    }
  }
  return length
}

/**
 * Combines the last API response's exact token count with rough estimation for
 * all subsequent messages, walking backward across sibling split assistant
 * records sharing the same `message.id` so interleaved parallel tool results
 * are counted accurately.
 */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  const last = getLastUsageBearingAssistant(messages)
  if (!last) {
    return roughTokenCountEstimationForMessages(messages)
  }

  let anchorIndex = last.index
  const lastMessageId = last.message.message.id
  if (lastMessageId) {
    while (anchorIndex > 0) {
      const prev = messages[anchorIndex - 1]
      if (
        prev?.type === 'assistant' &&
        prev.message.id === lastMessageId
      ) {
        anchorIndex--
      } else {
        break
      }
    }
  }

  const trailingMessages = messages.slice(anchorIndex + 1).filter(msg => {
    // Exclude sibling split blocks from the same assistant message already covered by `last.usage`
    if (msg.type === 'assistant' && msg.message.id === lastMessageId) {
      return false
    }
    return true
  })

  return (
    getTokenCountFromUsage(last.usage) +
    roughTokenCountEstimationForMessages(trailingMessages)
  )
}
