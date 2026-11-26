/**
 * Extended Anthropic API usage contract and immutable zeroed usage baseline.
 */

export interface NonNullableUsage {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use: {
    web_search_requests: number
    web_fetch_requests: number
  }
  service_tier: 'standard' | 'priority' | 'batch'
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  }
  inference_geo: string
  iterations: Array<Record<string, unknown>>
  speed: 'standard' | 'fast'
  cache_deleted_input_tokens?: number
}

export type PartialApiUsage = Partial<
  Omit<NonNullableUsage, 'server_tool_use' | 'cache_creation'>
> & {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_deleted_input_tokens?: number | null
  server_tool_use?: {
    web_search_requests?: number
    web_fetch_requests?: number
  } | null
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  } | null
  service_tier?: 'standard' | 'priority' | 'batch' | null
  inference_geo?: string | null
  iterations?: Array<Record<string, unknown>> | null
  speed?: 'standard' | 'fast' | null
}

export const EMPTY_USAGE: Readonly<NonNullableUsage> = Object.freeze({
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: Object.freeze({
    web_search_requests: 0,
    web_fetch_requests: 0,
  }),
  service_tier: 'standard',
  cache_creation: Object.freeze({
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  }),
  inference_geo: '',
  iterations: [],
  speed: 'standard',
})

/**
 * Merges a streaming `message_start` or `message_delta` usage snapshot into the
 * current message's cumulative usage. Preserves existing input/cache counts when
 * `message_delta` sends `0` or `null`.
 */
export function updateUsage(
  usage: NonNullableUsage,
  partUsage?: PartialApiUsage | null,
): NonNullableUsage {
  if (!partUsage) {
    return usage
  }

  const inputTokens =
    partUsage.input_tokens != null && partUsage.input_tokens > 0
      ? partUsage.input_tokens
      : usage.input_tokens
  const cacheCreationTokens =
    partUsage.cache_creation_input_tokens != null &&
    partUsage.cache_creation_input_tokens > 0
      ? partUsage.cache_creation_input_tokens
      : usage.cache_creation_input_tokens
  const cacheReadTokens =
    partUsage.cache_read_input_tokens != null &&
    partUsage.cache_read_input_tokens > 0
      ? partUsage.cache_read_input_tokens
      : usage.cache_read_input_tokens
  const cacheDeletedTokens =
    partUsage.cache_deleted_input_tokens != null &&
    partUsage.cache_deleted_input_tokens > 0
      ? partUsage.cache_deleted_input_tokens
      : usage.cache_deleted_input_tokens

  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: partUsage.service_tier ?? usage.service_tier,
    cache_creation: {
      ephemeral_1h_input_tokens:
        partUsage.cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        partUsage.cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: partUsage.inference_geo ?? usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: partUsage.speed ?? usage.speed,
    ...(cacheDeletedTokens !== undefined
      ? { cache_deleted_input_tokens: cacheDeletedTokens }
      : {}),
  }
}

/**
 * Accumulates a completed turn's usage into a running multi-turn total.
 */
export function accumulateUsage(
  totalUsage: NonNullableUsage,
  messageUsage: NonNullableUsage,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier || totalUsage.service_tier,
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: messageUsage.inference_geo || totalUsage.inference_geo,
    iterations: [...totalUsage.iterations, ...messageUsage.iterations],
    speed: messageUsage.speed || totalUsage.speed,
  }
}
