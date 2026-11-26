import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIError } from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  resetCostState,
  resetStateForTests,
} from '../../src/bootstrap/state.js'
import { getTotalCost } from '../../src/cost_tracker.js'
import { queryModelWithStreaming } from '../../src/services/api/claude.js'
import {
  checkResponseForCacheBreak,
  notifyCacheDeletion,
  recordPromptState,
  resetPromptCacheBreakDetection,
} from '../../src/services/api/prompt_cache_break_detection.js'
import {
  FallbackTriggeredError,
  FLOOR_OUTPUT_TOKENS,
  withRetry,
} from '../../src/services/api/with_retry.js'
import {
  extractQuotaStatusFromHeaders,
  getCurrentLimits,
  resetClaudeAiLimitsForTesting,
  statusListeners,
} from '../../src/services/claude_ai_limits.js'
import {
  resetMockRateLimits,
  setMockRateLimitScenario,
} from '../../src/services/mock_rate_limits.js'
import type { AssistantMessage } from '../../src/types/message.js'
import {
  isFastModeCooldown,
  resetFastModeStateForTesting,
} from '../../src/utilities/fast_mode.js'
import { createUserMessage } from '../../src/utilities/messages.js'
import { asSystemPrompt } from '../../src/utilities/system_prompt_type.js'

function makeMockStreamResponse(
  events: BetaRawMessageStreamEvent[],
  requestId = 'req_stream_1',
  errorAfterIndex?: number,
) {
  const controller = new AbortController()
  const iterable = {
    controller,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events.length; i++) {
        if (errorAfterIndex !== undefined && i === errorAfterIndex) {
          throw new Error('socket hang up mid-stream')
        }
        yield events[i]!
      }
    },
  }
  return {
    withResponse: async () => ({
      data: iterable,
      request_id: requestId,
      response: new Response(null, { status: 200 }),
    }),
  }
}

function buildSseEvents(textChunks: string[]): BetaRawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_sse_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 500,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as BetaRawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as unknown as BetaRawMessageStreamEvent,
    ...textChunks.map(
      text =>
        ({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }) as unknown as BetaRawMessageStreamEvent,
    ),
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as BetaRawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 42 },
    } as unknown as BetaRawMessageStreamEvent,
    {
      type: 'message_stop',
    } as unknown as BetaRawMessageStreamEvent,
  ]
}

beforeEach(() => {
  resetStateForTests()
  resetCostState()
  resetFastModeStateForTesting()
  resetPromptCacheBreakDetection()
  resetClaudeAiLimitsForTesting()
  resetMockRateLimits()
})

afterEach(() => {
  resetStateForTests()
  resetCostState()
  resetFastModeStateForTesting()
  resetPromptCacheBreakDetection()
  resetClaudeAiLimitsForTesting()
  resetMockRateLimits()
})

describe('Step 2.3 — Raw SSE Streaming, Smart Retries, Cache Break Detection, Rate Limits', () => {
  test('queryModelWithStreaming yields StreamEvents, AssistantMessage on content_block_stop, and patches usage in place', async () => {
    const mockClient = {
      beta: {
        messages: {
          create: () => makeMockStreamResponse(buildSseEvents(['Hello ', 'world!'])),
        },
      },
    } as unknown as Anthropic

    const events = []
    for await (const item of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'Hi' })],
      systemPrompt: asSystemPrompt(['You are helpful.']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        model: 'claude-sonnet-4-6',
        querySource: 'sdk',
        clientFactoryOverride: async () => mockClient,
      },
    })) {
      events.push(item)
    }

    const assistantMsgs = events.filter(
      (e): e is AssistantMessage => e.type === 'assistant',
    )
    const streamEvents = events.filter(e => e.type === 'stream_event')
    expect(streamEvents.length).toBeGreaterThanOrEqual(4)
    expect(assistantMsgs).toHaveLength(1)

    const msg = assistantMsgs[0]!
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: 'Hello world!',
    })
    // Patched in place on message_delta
    expect(msg.message.stop_reason).toBe('end_turn')
    expect(msg.message.usage.output_tokens).toBe(42)
    expect(getTotalCost()).toBeGreaterThan(0)
  })

  test('mid-stream failure triggers onStreamingFallback and recovers via non-streaming call capped at <=64k tokens', async () => {
    let capturedNonStreamMaxTokens: number | undefined
    let fallbackCalled = 0

    const mockClient = {
      beta: {
        messages: {
          create: (params: Record<string, unknown>) => {
            if (params.stream) {
              return makeMockStreamResponse(
                buildSseEvents(['partial']),
                'req_drop',
                2,
              )
            }
            capturedNonStreamMaxTokens = Number(params.max_tokens)
            const fallbackMsg: BetaMessage = {
              id: 'msg_fallback_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [{ type: 'text', text: 'Recovered via non-streaming!' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: 300,
                output_tokens: 20,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                server_tool_use: null,
                service_tier: null,
              },
            } as unknown as BetaMessage
            return {
              withResponse: async () => ({
                data: fallbackMsg,
                request_id: 'req_fallback_1',
                response: new Response(null, { status: 200 }),
              }),
            }
          },
        },
      },
    } as unknown as Anthropic

    const yielded = []
    for await (const item of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'Recover me' })],
      systemPrompt: asSystemPrompt(['System']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        model: 'claude-sonnet-4-6',
        maxOutputTokensOverride: 120_000,
        onStreamingFallback: () => {
          fallbackCalled++
        },
        clientFactoryOverride: async () => mockClient,
      },
    })) {
      yielded.push(item)
    }

    expect(fallbackCalled).toBe(1)
    expect(capturedNonStreamMaxTokens).toBeLessThanOrEqual(64_000)
    const lastAssistant = yielded.filter(
      (e): e is AssistantMessage => e.type === 'assistant',
    ).at(-1)
    expect(lastAssistant?.message.content[0]).toMatchObject({
      type: 'text',
      text: 'Recovered via non-streaming!',
    })
  })

  test('withRetry handles 429 exponential backoff + Retry-After, 3x 529 FallbackTriggeredError, 400 overflow max_tokens reduction, and fast-mode cooldown', async () => {
    const dummyClient = {} as Anthropic

    // 1. 429 with Retry-After + exponential backoff
    const delays: number[] = []
    let attempt429 = 0
    const retryGen429 = withRetry(
      async () => dummyClient,
      async () => {
        attempt429++
        if (attempt429 === 1) {
          throw new APIError(
            429,
            { type: 'error', error: { type: 'rate_limit_error', message: 'rate limit' } },
            'rate limit',
            new Headers({ 'retry-after': '2' }),
          )
        }
        if (attempt429 === 2) {
          throw new APIError(
            429,
            { type: 'error', error: { type: 'rate_limit_error', message: 'rate limit' } },
            'rate limit',
            new Headers(),
          )
        }
        return 'ok-after-429'
      },
      {
        model: 'claude-sonnet-4-6',
        thinkingConfig: { type: 'disabled' },
        sleepFn: async ms => {
          delays.push(ms)
        },
      },
    )
    let res429: string | undefined
    while (true) {
      const next = await retryGen429.next()
      if (next.done) {
        res429 = next.value
        break
      }
    }
    expect(res429).toBe('ok-after-429')
    expect(delays[0]).toBe(2000)
    expect(delays[1]!).toBeGreaterThanOrEqual(1000)

    // 2. 3 consecutive 529 overloaded errors throw FallbackTriggeredError
    let attempts529 = 0
    const gen529 = withRetry(
      async () => dummyClient,
      async () => {
        attempts529++
        throw new APIError(
          529,
          { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } },
          'overloaded',
          new Headers(),
        )
      },
      {
        model: 'claude-opus-4-6',
        fallbackModel: 'claude-sonnet-4-6',
        thinkingConfig: { type: 'disabled' },
        querySource: 'repl_main_thread',
        sleepFn: async () => {},
      },
    )
    let caughtFallback: unknown
    try {
      while (!(await gen529.next()).done) {
        // drain retry notifications
      }
    } catch (error) {
      caughtFallback = error
    }
    expect(caughtFallback).toBeInstanceOf(FallbackTriggeredError)
    expect((caughtFallback as FallbackTriggeredError).fallbackModel).toBe(
      'claude-sonnet-4-6',
    )
    expect(attempts529).toBe(3)

    // 3. 400 context overflow reduces maxTokensOverride down to FLOOR_OUTPUT_TOKENS (3000)
    const seenMaxTokens: Array<number | undefined> = []
    let overflowAttempt = 0
    const gen400 = withRetry(
      async () => dummyClient,
      async (_client, _attempt, ctx) => {
        overflowAttempt++
        seenMaxTokens.push(ctx.maxTokensOverride)
        if (overflowAttempt === 1) {
          throw new APIError(
            400,
            {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message:
                  'input length and `max_tokens` exceed context limit: 195000 + 16000 > 200000',
              },
            },
            'input length and `max_tokens` exceed context limit: 195000 + 16000 > 200000',
            new Headers(),
          )
        }
        return 'adjusted-ok'
      },
      {
        model: 'claude-sonnet-4-6',
        thinkingConfig: { type: 'disabled' },
        sleepFn: async () => {},
      },
    )
    let res400: string | undefined
    while (true) {
      const next = await gen400.next()
      if (next.done) {
        res400 = next.value
        break
      }
    }
    expect(res400).toBe('adjusted-ok')
    // Available = 200000 - 195000 - 1000 safety margin = 4000 (>= 3000 floor)
    expect(seenMaxTokens[1]).toBe(4000)
    expect(FLOOR_OUTPUT_TOKENS).toBe(3000)

    // 4. Fast mode 429 triggers cooldown and retries with fastMode=false
    let fastRetryAttempt = 0
    let secondAttemptFastMode: boolean | undefined
    const genFast = withRetry(
      async () => dummyClient,
      async (_client, _attempt, ctx) => {
        fastRetryAttempt++
        if (fastRetryAttempt === 1) {
          throw new APIError(
            429,
            { type: 'error', error: { type: 'rate_limit_error', message: 'fast limit' } },
            'fast limit',
            new Headers({ 'retry-after': '120' }),
          )
        }
        secondAttemptFastMode = ctx.fastMode
        return 'fast-fallback-ok'
      },
      {
        model: 'claude-opus-4-6',
        thinkingConfig: { type: 'disabled' },
        fastMode: true,
        sleepFn: async () => {},
      },
    )
    while (!(await genFast.next()).done) {
      // drain
    }
    expect(isFastModeCooldown()).toBe(true)
    expect(secondAttemptFastMode).toBe(false)
  })

  test('2-stage promptCacheBreakDetection detects cache drops on system prompt changes and suppresses expected deletions', async () => {
    // Baseline call
    recordPromptState({
      querySource: 'repl_main_thread',
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'Original static system prompt' }],
      toolSchemas: [{ name: 'Read', description: 'Read file' }],
      betas: ['prompt-caching-scope-2026-01-05'],
    })
    const baselineCheck = await checkResponseForCacheBreak(
      'repl_main_thread',
      20_000,
      0,
      [],
    )
    expect(baselineCheck.detected).toBe(false)

    // Mutate system prompt -> >5% AND >=2000 drop in cache_read_input_tokens
    recordPromptState({
      querySource: 'repl_main_thread',
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'Mutated static system prompt!' }],
      toolSchemas: [{ name: 'Read', description: 'Read file' }],
      betas: ['prompt-caching-scope-2026-01-05'],
    })
    const breakResult = await checkResponseForCacheBreak(
      'repl_main_thread',
      5_000,
      15_000,
      [],
    )
    expect(breakResult.detected).toBe(true)
    expect(breakResult.reason).toContain('system')

    // Expected cache deletion suppresses false positive
    notifyCacheDeletion('repl_main_thread')
    recordPromptState({
      querySource: 'repl_main_thread',
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'Mutated static system prompt!' }],
      toolSchemas: [{ name: 'Read', description: 'Read file' }],
      betas: ['prompt-caching-scope-2026-01-05'],
    })
    const suppressed = await checkResponseForCacheBreak(
      'repl_main_thread',
      1_000,
      4_000,
      [],
    )
    expect(suppressed.detected).toBe(false)
  })

  test('claude_ai_limits extracts unified quota headers, notifies subscribers, and supports mock scenarios', () => {
    const observedStatuses: string[] = []
    const listener = (limits: { status: string }) => {
      observedStatuses.push(limits.status)
    }
    statusListeners.add(listener)

    setMockRateLimitScenario('warning_5h')
    const headers = new Headers({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-utilization': '0.92',
      'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9',
    })
    extractQuotaStatusFromHeaders(headers)
    expect(getCurrentLimits().status).toBe('allowed_warning')
    expect(observedStatuses).toContain('allowed_warning')
    statusListeners.delete(listener)
  })
})
