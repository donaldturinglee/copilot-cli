import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  resetCostState,
  resetStateForTests,
} from '../../src/bootstrap/state.js'
import { addToTotalSessionCost } from '../../src/cost_tracker.js'
import {
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  query,
  type QueryEvent,
} from '../../src/query.js'
import type { QueryDeps } from '../../src/query/deps.js'
import {
  checkTokenBudget,
  createBudgetTracker,
} from '../../src/query/token_budget.js'
import { QueryEngine } from '../../src/query_engine.js'
import { setGrowthBookConfigOverride } from '../../src/services/analytics/growthbook.js'
import type { QueryModelParams } from '../../src/services/api/claude.js'
import { EMPTY_USAGE } from '../../src/services/api/empty_usage.js'
import { FallbackTriggeredError } from '../../src/services/api/with_retry.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import type { CanUseToolFn, ToolUseContext } from '../../src/types/forward.js'
import type { AssistantMessage, Message } from '../../src/types/message.js'
import {
  getLastCacheSafeParams,
  saveCacheSafeParams,
} from '../../src/utilities/cache_safe_params.js'
import { ESCALATED_MAX_TOKENS } from '../../src/utilities/context.js'
import { runForkedAgent } from '../../src/utilities/forked_agent.js'
import {
  createAssistantApiErrorMessage,
  createUserMessage,
} from '../../src/utilities/messages.js'
import { QueryGuard } from '../../src/utilities/query_guard.js'
import { sideQuery } from '../../src/utilities/side_query.js'
import { asSystemPrompt } from '../../src/utilities/system_prompt_type.js'
import { parseTokenBudget } from '../../src/utilities/token_budget.js'

function makeAssistantMessage(options: {
  text?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
  stopReason?: string | null
  model?: string
  outputTokens?: number
}): AssistantMessage {
  const content: Array<Record<string, unknown>> = []
  if (options.text) {
    content.push({ type: 'text', text: options.text })
  }
  if (options.toolUse) {
    content.push({
      type: 'tool_use',
      id: options.toolUse.id,
      name: options.toolUse.name,
      input: options.toolUse.input,
    })
  }
  return {
    type: 'assistant',
    requestId: 'req_mock',
    uuid: '00000000-0000-4000-8000-000000000099',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: options.model ?? 'claude-sonnet-4-6',
      content,
      stop_reason: options.stopReason ?? 'end_turn',
      stop_sequence: null,
      usage: {
        ...EMPTY_USAGE,
        input_tokens: 100,
        output_tokens: options.outputTokens ?? 25,
      },
    } as unknown as AssistantMessage['message'],
  }
}

function makeToolUseContext(model = 'claude-sonnet-4-6'): ToolUseContext {
  const store = createStore(getDefaultAppState())
  return {
    abortController: new AbortController(),
    messages: [],
    options: {
      mainLoopModel: model,
      tools: [],
      thinkingConfig: { type: 'disabled' },
      isNonInteractiveSession: true,
    },
    getAppState: () => store.getState(),
    setAppState: (updater: (prev: AppState) => AppState) =>
      store.setState(updater),
    readFileState: new Map(),
  }
}

const allowAll: CanUseToolFn = async (_tool, input) => ({
  behavior: 'allow',
  updatedInput: input,
})

beforeEach(() => {
  resetStateForTests()
  resetCostState()
  saveCacheSafeParams(null)
})

afterEach(() => {
  resetStateForTests()
  resetCostState()
  saveCacheSafeParams(null)
})

describe('Steps 2.5–2.6 — Core query() State Machine, Forked Agent, SideQuery, and QueryEngine', () => {
  test('query() executes multi-turn tool loop and terminates cleanly on end_turn', async () => {
    let callCount = 0
    const deps: QueryDeps = {
      callModel: async function* () {
        callCount++
        if (callCount === 1) {
          yield makeAssistantMessage({
            toolUse: { id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
            stopReason: 'tool_use',
          })
          return
        }
        yield makeAssistantMessage({
          text: 'All done after reading a.ts!',
          stopReason: 'end_turn',
        })
      },
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      uuid: () => '00000000-0000-4000-8000-000000000001',
      runTools: async function* (blocks) {
        yield {
          message: createUserMessage({
            content: blocks.map(b => ({
              type: 'tool_result' as const,
              tool_use_id: b.id,
              content: 'export const x = 1',
            })),
          }),
        }
      },
    }

    const events: QueryEvent[] = []
    const gen = query({
      messages: [createUserMessage({ content: 'Read a.ts' })],
      systemPrompt: asSystemPrompt(['System']),
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: makeToolUseContext(),
      querySource: 'sdk',
      deps,
    })

    let terminal
    while (true) {
      const next = await gen.next()
      if (next.done) {
        terminal = next.value
        break
      }
      events.push(next.value)
    }

    expect(callCount).toBe(2)
    expect(terminal.reason).toBe('completed')
    expect(getLastCacheSafeParams()).not.toBeNull()
    const texts = events
      .filter((e): e is AssistantMessage => e.type === 'assistant')
      .map(m =>
        m.message.content
          .filter(b => b.type === 'text')
          .map(b => (b as { text: string }).text)
          .join(''),
      )
    expect(texts).toContain('All done after reading a.ts!')
  })

  test('query() withholds max_output_tokens for 8k->64k escalation and continuation nudges', async () => {
    setGrowthBookConfigOverride('tengu_otk_slot_v1', true)
    const seenMaxOverrides: Array<number | undefined> = []
    let calls = 0

    try {
      const deps: QueryDeps = {
        callModel: async function* (params: QueryModelParams) {
          calls++
          seenMaxOverrides.push(params.options.maxOutputTokensOverride)
          if (calls <= 2) {
            yield createAssistantApiErrorMessage({
              content: `cut-${calls}`,
              apiError: 'max_output_tokens',
              error: 'max_output_tokens',
            })
            return
          }
          yield makeAssistantMessage({
            text: 'Completed after escalation + recovery nudge',
            stopReason: 'end_turn',
          })
        },
        microcompact: async messages => ({ messages }),
        autocompact: async () => ({ wasCompacted: false }),
        uuid: () => '00000000-0000-4000-8000-000000000002',
      }

      const events: QueryEvent[] = []
      const gen = query({
        messages: [createUserMessage({ content: 'Write long code' })],
        systemPrompt: asSystemPrompt(['System']),
        userContext: {},
        systemContext: {},
        canUseTool: allowAll,
        toolUseContext: makeToolUseContext(),
        querySource: 'sdk',
        deps,
      })
      while (true) {
        const next = await gen.next()
        if (next.done) {
          expect(next.value.reason).toBe('completed')
          break
        }
        events.push(next.value)
      }

      expect(calls).toBe(3)
      expect(seenMaxOverrides[1]).toBe(ESCALATED_MAX_TOKENS)
      expect(MAX_OUTPUT_TOKENS_RECOVERY_LIMIT).toBe(3)
      // Withheld max_output_tokens messages were not yielded
      const assistantTexts = events
        .filter((e): e is AssistantMessage => e.type === 'assistant')
        .map(m =>
          m.message.content
            .filter(b => b.type === 'text')
            .map(b => (b as { text: string }).text)
            .join(''),
        )
      expect(assistantTexts).not.toContain('cut-1')
      expect(assistantTexts).not.toContain('cut-2')
      expect(assistantTexts).toContain(
        'Completed after escalation + recovery nudge',
      )
    } finally {
      setGrowthBookConfigOverride('tengu_otk_slot_v1', undefined)
    }
  })

  test('query() switches to fallbackModel on FallbackTriggeredError and respects maxTurns', async () => {
    const modelsUsed: string[] = []
    const depsFallback: QueryDeps = {
      callModel: async function* (params: QueryModelParams) {
        modelsUsed.push(params.options.model)
        if (modelsUsed.length === 1) {
          yield makeAssistantMessage({ text: 'orphan', stopReason: null })
          throw new FallbackTriggeredError(
            params.options.model,
            'claude-sonnet-4-6',
          )
        }
        yield makeAssistantMessage({
          text: 'Fallback succeeded',
          stopReason: 'end_turn',
          model: params.options.model,
        })
      },
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      uuid: () => '00000000-0000-4000-8000-000000000003',
    }

    const events: QueryEvent[] = []
    const gen = query({
      messages: [createUserMessage({ content: 'Try opus' })],
      systemPrompt: asSystemPrompt(['System']),
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: makeToolUseContext('claude-opus-4-6'),
      fallbackModel: 'claude-sonnet-4-6',
      querySource: 'sdk',
      deps: depsFallback,
    })
    while (!(await gen.next()).done) {
      // collect via manual loop below
    }
    expect(modelsUsed).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6'])

    // maxTurns termination
    const depsMaxTurns: QueryDeps = {
      callModel: async function* () {
        yield makeAssistantMessage({
          toolUse: { id: 'toolu_loop', name: 'Read', input: {} },
          stopReason: 'tool_use',
        })
      },
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      uuid: () => '00000000-0000-4000-8000-000000000004',
      runTools: async function* (blocks) {
        yield {
          message: createUserMessage({
            content: blocks.map(b => ({
              type: 'tool_result' as const,
              tool_use_id: b.id,
              content: 'ok',
            })),
          }),
        }
      },
    }

    const maxTurnsGen = query({
      messages: [createUserMessage({ content: 'Loop forever' })],
      systemPrompt: asSystemPrompt(['System']),
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: makeToolUseContext(),
      querySource: 'sdk',
      maxTurns: 2,
      deps: depsMaxTurns,
    })
    let maxTurnsTerminal
    while (true) {
      const next = await maxTurnsGen.next()
      if (next.done) {
        maxTurnsTerminal = next.value
        break
      }
      events.push(next.value)
    }
    expect(maxTurnsTerminal.reason).toBe('max_turns')
  })

  test('token budget parsing, continuation <90%, diminishing returns, QueryGuard, sideQuery, and runForkedAgent (skipCacheWrite)', async () => {
    expect(parseTokenBudget('+500k build feature')).toBe(500_000)
    expect(parseTokenBudget('refactor everything +1.5m')).toBe(1_500_000)
    expect(parseTokenBudget('use 200k tokens on tests')).toBe(200_000)
    expect(parseTokenBudget('normal prompt')).toBeNull()

    const tracker = createBudgetTracker()
    const d1 = checkTokenBudget(tracker, undefined, 10_000, 1_000)
    expect(d1.action).toBe('continue')
    const d2 = checkTokenBudget(tracker, undefined, 10_000, 1_100)
    expect(d2.action).toBe('continue')
    const d3 = checkTokenBudget(tracker, undefined, 10_000, 1_200)
    expect(d3.action).toBe('continue')
    // 4th check after 3 continuations with <500 delta twice triggers diminishing returns stop
    const d4 = checkTokenBudget(tracker, undefined, 10_000, 1_300)
    expect(d4.action).toBe('stop')
    if (d4.action === 'stop') {
      expect(d4.completionEvent?.diminishingReturns).toBe(true)
    }

    // QueryGuard 3-state transitions & stale generation rejection
    const guard = new QueryGuard()
    expect(guard.isActive).toBe(false)
    expect(guard.reserve()).toBe(true)
    expect(guard.reserve()).toBe(false)
    const gen1 = guard.tryStart()
    expect(gen1).toBe(1)
    expect(guard.tryStart()).toBeNull()
    guard.forceEnd()
    expect(guard.isActive).toBe(false)
    expect(guard.end(gen1!)).toBe(false)

    // sideQuery with mock client
    const mockSideClient = {
      beta: {
        messages: {
          create: () => ({
            withResponse: async () => ({
              data: {
                id: 'msg_side_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-haiku-4-5-20251001',
                content: [{ type: 'text', text: 'side answer' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: EMPTY_USAGE,
              } as unknown as BetaMessage,
              request_id: 'req_side_1',
            }),
          }),
        },
      },
    } as unknown as Anthropic
    const sideRes = await sideQuery({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Classify' }],
      querySource: 'side_question',
      clientFactoryOverride: async () => mockSideClient,
    })
    expect(sideRes.id).toBe('msg_side_1')

    // runForkedAgent passes skipCacheWrite: true and isolates context
    let capturedSkipCacheWrite: boolean | undefined
    const parentCtx = makeToolUseContext()
    const forkResult = await runForkedAgent({
      promptMessages: [createUserMessage({ content: 'Summarize' })],
      cacheSafeParams: {
        systemPrompt: asSystemPrompt(['Parent system']),
        userContext: {},
        systemContext: {},
        toolUseContext: parentCtx,
        forkContextMessages: [createUserMessage({ content: 'Prior turn' })],
      },
      canUseTool: allowAll,
      querySource: 'compact',
      forkLabel: 'summary',
      deps: {
        callModel: async function* (params: QueryModelParams) {
          capturedSkipCacheWrite = params.options.skipCacheWrite
          yield makeAssistantMessage({ text: 'Fork summary', stopReason: 'end_turn' })
        },
        microcompact: async messages => ({ messages }),
        autocompact: async () => ({ wasCompacted: false }),
        uuid: () => '00000000-0000-4000-8000-000000000005',
      },
    })
    expect(capturedSkipCacheWrite).toBe(true)
    expect(forkResult.messages.length).toBeGreaterThanOrEqual(1)
  })

  test('QueryEngine.submitMessage emits system/init, assistant, result/success, and enforces maxBudgetUsd', async () => {
    const store = createStore(getDefaultAppState())
    const deps: QueryDeps = {
      callModel: async function* () {
        addToTotalSessionCost(
          0.02,
          { ...EMPTY_USAGE, input_tokens: 200, output_tokens: 50 },
          'claude-sonnet-4-6',
        )
        yield makeAssistantMessage({
          text: 'The event loop processes tasks in phases.',
          stopReason: 'end_turn',
          outputTokens: 50,
        })
      },
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      uuid: () => '00000000-0000-4000-8000-000000000006',
    }

    const engine = new QueryEngine({
      cwd: process.cwd(),
      tools: [],
      commands: [],
      mcpClients: [],
      canUseTool: allowAll,
      getAppState: () => store.getState(),
      setAppState: updater => store.setState(updater),
      userSpecifiedModel: 'claude-sonnet-4-6',
      deps,
    })

    const emitted = []
    for await (const msg of engine.submitMessage('Explain event loop')) {
      emitted.push(msg)
    }

    expect(emitted[0]?.type).toBe('system')
    expect(emitted.some(m => m.type === 'assistant')).toBe(true)
    const result = emitted.at(-1)
    expect(result?.type).toBe('result')
    if (result?.type === 'result') {
      expect(result.subtype).toBe('success')
      expect(result.total_cost_usd).toBeGreaterThan(0)
      if (result.subtype === 'success') {
        expect(result.result).toBe('The event loop processes tasks in phases.')
      }
    }

    // maxBudgetUsd enforcement
    const budgetEngine = new QueryEngine({
      cwd: process.cwd(),
      tools: [],
      commands: [],
      mcpClients: [],
      canUseTool: allowAll,
      getAppState: () => store.getState(),
      setAppState: updater => store.setState(updater),
      userSpecifiedModel: 'claude-sonnet-4-6',
      maxBudgetUsd: 0.005,
      deps,
    })
    const budgetEvents = []
    for await (const msg of budgetEngine.submitMessage('Too expensive')) {
      budgetEvents.push(msg)
    }
    const budgetResult = budgetEvents.at(-1)
    expect(budgetResult?.type).toBe('result')
    if (budgetResult?.type === 'result') {
      expect(budgetResult.subtype).toBe('error_max_budget_usd')
    }
  })
})
