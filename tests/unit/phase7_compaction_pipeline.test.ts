import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { UUID } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import { productionDeps, type QueryDeps } from '../../src/query/deps.js'
import { EMPTY_USAGE } from '../../src/services/api/empty_usage.js'
import { getApiContextManagement } from '../../src/services/compact/api_microcompact.js'
import {
  autoCompactIfNeeded,
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from '../../src/services/compact/auto_compact.js'
import {
  compactConversation,
  partialCompactConversation,
} from '../../src/services/compact/compact.js'
import {
  clearCompactWarningSuppression,
  compactWarningStore,
  suppressCompactWarning,
} from '../../src/services/compact/compact_warning_state.js'
import { groupMessagesByApiRound } from '../../src/services/compact/grouping.js'
import {
  COMPACTABLE_TOOLS,
  estimateMessageTokens,
  microcompactMessages,
  resetMicrocompactState,
  TIME_BASED_MC_CLEARED_MESSAGE,
} from '../../src/services/compact/micro_compact.js'
import { setTimeBasedMcConfigForTesting } from '../../src/services/compact/time_based_mc_config.js'
import {
  formatCompactSummary,
  getCompactPrompt,
} from '../../src/services/compact/prompt.js'
import {
  adjustIndexToPreserveApiInvariants,
  trySessionMemoryCompaction,
} from '../../src/services/compact/session_memory_compact.js'
import {
  getSessionMemoryPath,
  resetSessionMemoryState,
  setLastSummarizedMessageId,
} from '../../src/services/session_memory/session_memory_utils.js'
import type { AssistantMessage, Message, UserMessage } from '../../src/types/message.js'
import { createCacheSafeParams } from '../../src/utilities/cache_safe_params.js'
import { randomUUID } from '../../src/utilities/crypto.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utilities/messages.js'
import { asSystemPrompt } from '../../src/utilities/system_prompt_type.js'
import {
  applyToolResultBudget,
  createContentReplacementState,
  reconstructContentReplacementState,
} from '../../src/utilities/tool_result_storage.js'

function makeToolPair(
  toolName: string,
  toolId: string,
  resultText: string,
  timestampIso: string,
  sharedMsgId?: string,
): [AssistantMessage, UserMessage] {
  const aUuid = randomUUID() as UUID
  const assistant: AssistantMessage = {
    type: 'assistant',
    uuid: aUuid,
    timestamp: timestampIso,
    requestId: 'req_mc',
    message: {
      id: sharedMsgId ?? `msg_${aUuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input: { file_path: 'foo.ts' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { ...EMPTY_USAGE } as BetaMessage['usage'],
    } as BetaMessage,
  }
  const user: UserMessage = {
    ...createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          content: resultText,
        },
      ],
    }),
    timestamp: timestampIso,
  }
  return [assistant, user]
}

describe('Phase 7.3 — Multi-Tier Context Compaction Pipeline', () => {
  let tempRoot: string
  let configDir: string
  let workDir: string
  let savedConfigDir: string | undefined
  let savedWindow: string | undefined
  let savedBlocking: string | undefined
  let savedUserType: string | undefined
  let savedSmCompact: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    savedWindow = process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW
    savedBlocking = process.env.COPILOT_CLI_BLOCKING_LIMIT_OVERRIDE
    savedUserType = process.env.USER_TYPE
    savedSmCompact = process.env.ENABLE_COPILOT_CLI_SM_COMPACT
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-p7-s3-'))
    configDir = join(tempRoot, 'config')
    workDir = join(tempRoot, 'repo')
    mkdirSync(workDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW
    delete process.env.COPILOT_CLI_BLOCKING_LIMIT_OVERRIDE
    delete process.env.ENABLE_COPILOT_CLI_SM_COMPACT
    setTimeBasedMcConfigForTesting(null)
    resetStateForTests()
    resetSessionMemoryState()
    resetMicrocompactState()
    clearCompactWarningSuppression()
    setOriginalCwd(workDir)
    setCwdState(workDir)
  })

  afterEach(() => {
    setTimeBasedMcConfigForTesting(null)
    resetSessionMemoryState()
    resetMicrocompactState()
    clearCompactWarningSuppression()
    resetStateForTests()
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    if (savedWindow === undefined) delete process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW
    else process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW = savedWindow
    if (savedBlocking === undefined) {
      delete process.env.COPILOT_CLI_BLOCKING_LIMIT_OVERRIDE
    } else {
      process.env.COPILOT_CLI_BLOCKING_LIMIT_OVERRIDE = savedBlocking
    }
    if (savedUserType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = savedUserType
    if (savedSmCompact === undefined) delete process.env.ENABLE_COPILOT_CLI_SM_COMPACT
    else process.env.ENABLE_COPILOT_CLI_SM_COMPACT = savedSmCompact
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('Tier 0 tool-result budget persists oversized outputs and reconstructs deterministically', async () => {
    const state = createContentReplacementState()
    const [a, u] = makeToolPair(
      'Bash',
      'toolu_huge_1',
      'L'.repeat(120_000),
      new Date().toISOString(),
    )
    const budgeted = await applyToolResultBudget([a, u], state, undefined, 20_000)
    expect(budgeted.replacedIds).toContain('toolu_huge_1')
    expect(state.records.length).toBe(1)

    const reconstructed = reconstructContentReplacementState(state.records)
    expect(reconstructed.seenIds.has('toolu_huge_1')).toBe(true)
    expect(reconstructed.replacements.get('toolu_huge_1')).toContain('<persisted-output>')
  })

  test('Tier 2a time-based microcompact clears old tool results after 60m idle gap while keeping latest 5 intact', async () => {
    expect(COMPACTABLE_TOOLS.size).toBe(9)
    const oldTime = new Date(Date.now() - 90 * 60_000).toISOString()
    const messages: Message[] = [createUserMessage({ content: 'Analyze repo' })]

    for (let i = 1; i <= 8; i++) {
      const [a, u] = makeToolPair(
        'Read',
        `toolu_mc_${i}`,
        `Full file output #${i} `.repeat(200),
        oldTime,
      )
      messages.push(a, u)
    }

    setTimeBasedMcConfigForTesting({ enabled: true, gapThresholdMinutes: 60, keepRecent: 5 })
    const res = await microcompactMessages(messages, undefined, 'repl_main_thread')
    expect(compactWarningStore.getState()).toBe(true)

    const resultContents: string[] = []
    for (const m of res.messages) {
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_result' && typeof b.content === 'string') {
            resultContents.push(b.content)
          }
        }
      }
    }
    expect(resultContents.length).toBe(8)
    // First 3 cleared, latest 5 preserved!
    expect(resultContents[0]).toBe(TIME_BASED_MC_CLEARED_MESSAGE)
    expect(resultContents[1]).toBe(TIME_BASED_MC_CLEARED_MESSAGE)
    expect(resultContents[2]).toBe(TIME_BASED_MC_CLEARED_MESSAGE)
    expect(resultContents[3]).toContain('Full file output #4')
    expect(resultContents[7]).toContain('Full file output #8')

    // Warning suppression toggle
    suppressCompactWarning()
    expect(compactWarningStore.getState()).toBe(true)
    clearCompactWarningSuppression()
    expect(compactWarningStore.getState()).toBe(false)
  })

  test('Tier 2c getApiContextManagement emits clear_thinking_20251015 all vs 1 turn after latch', () => {
    const keepAll = getApiContextManagement({
      hasThinking: true,
      isRedactThinkingActive: false,
      clearAllThinking: false,
    })
    expect(keepAll?.edits[0]).toEqual({
      type: 'clear_thinking_20251015',
      keep: 'all',
    })

    const keepOne = getApiContextManagement({
      hasThinking: true,
      isRedactThinkingActive: false,
      clearAllThinking: true,
    })
    expect(keepOne?.edits[0]).toEqual({
      type: 'clear_thinking_20251015',
      keep: { type: 'thinking_turns', value: 1 },
    })

    // Suppressed when redact-thinking is active
    expect(
      getApiContextManagement({
        hasThinking: true,
        isRedactThinkingActive: true,
      }),
    ).toBeUndefined()
  })

  test('Tier 4a trySessionMemoryCompaction replaces old history with summary.md with zero LLM calls and preserves tool_use/tool_result invariants', async () => {
    // 1. Verify adjustIndexToPreserveApiInvariants never splits a tool_use/tool_result pair or shared assistant message.id
    const now = new Date().toISOString()
    const [aSplit1, uRes1] = makeToolPair('Read', 't1', 'ok1', now, 'shared_msg_id')
    const [aSplit2, uRes2] = makeToolPair('Read', 't2', 'ok2', now, 'shared_msg_id')
    const chain: Message[] = [
      createUserMessage({ content: 'start' }),
      aSplit1,
      aSplit2,
      uRes1,
      uRes2,
    ]
    // Starting right at uRes1 (index 3) MUST walk backward to index 1 (aSplit1)
    expect(adjustIndexToPreserveApiInvariants(chain, 3)).toBe(1)

    // 2. Write non-empty session-memory/summary.md and trigger Tier 4a
    const smPath = getSessionMemoryPath()
    mkdirSync(join(smPath, '..'), { recursive: true })
    writeFileSync(
      smPath,
      '# Session Title\nCompaction Verification\n\n# Current State\nAll Phase 7 tests underway.\n',
      'utf8',
    )

    const messages: Message[] = []
    for (let i = 0; i < 12; i++) {
      messages.push(
        createUserMessage({ content: `User turn ${i}: ${'detail '.repeat(300)}` }),
        createAssistantMessage({
          content: `Assistant turn ${i}: ${'response '.repeat(300)}`,
        }),
      )
    }
    process.env.ENABLE_COPILOT_CLI_SM_COMPACT = '1'
    setLastSummarizedMessageId(messages[15]!.uuid)

    const result = await trySessionMemoryCompaction(messages)
    expect(result).not.toBeNull()
    expect(result!.boundaryMarker.subtype).toBe('compact_boundary')
    expect(result!.summaryMessages.length).toBe(1)
    expect(
      typeof result!.summaryMessages[0]!.message.content === 'string' &&
        result!.summaryMessages[0]!.message.content.includes('Compaction Verification'),
    ).toBe(true)
    expect((result!.messagesToKeep ?? []).length).toBeGreaterThan(0)
  })

  test('Tier 4b threshold math, 3-failure circuit breaker, PTL head-trim retry, and partial compaction', async () => {
    process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW = '40000'
    const eff = getEffectiveContextWindowSize('claude-sonnet-4-6')
    // 40,000 - 20,000 summary reserve = 20,000
    expect(eff).toBe(20_000)
    // Auto trigger = 20,000 - 13,000 = 7,000
    expect(getAutoCompactThreshold('claude-sonnet-4-6')).toBe(7_000)

    const warn = calculateTokenWarningState(18_000, 'claude-sonnet-4-6')
    expect(warn.isAboveAutoCompactThreshold).toBe(true)
    expect(warn.isAtBlockingLimit).toBe(true) // 18k >= 20k - 3k = 17k

    // Summary prompt & formatter
    expect(getCompactPrompt('focus on tests')).toContain('focus on tests')
    const formatted = formatCompactSummary(
      '<analysis>scratchpad</analysis>\n<summary>Final clean summary</summary>',
    )
    expect(formatted).toContain('Final clean summary')
    expect(formatted).not.toContain('scratchpad')

    // Build messages large enough to exceed 7,000 tokens
    const bigMsgs: Message[] = []
    for (let i = 0; i < 10; i++) {
      bigMsgs.push(
        createUserMessage({ content: `Task step ${i}: ` + 'A'.repeat(2_000) }),
        createAssistantMessage({ content: `Completed ${i}: ` + 'B'.repeat(2_000) }),
      )
    }
    expect(estimateMessageTokens(bigMsgs)).toBeGreaterThan(7_000)
    expect(groupMessagesByApiRound(bigMsgs).length).toBeGreaterThanOrEqual(5)

    // Mock callModel: returns PTL error on first attempt, then valid <summary> on retry!
    let apiCalls = 0
    const mockDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel() {
        apiCalls++
        if (apiCalls === 1) {
          yield createAssistantMessage({
            content: 'Prompt is too long: 90000 tokens > 40000 maximum',
          })
          return
        }
        yield createAssistantMessage({
          content: '<summary>Compacted after PTL head-trim retry.</summary>',
        })
      },
    }

    const toolUseContext = {
      abortController: new AbortController(),
      messages: bigMsgs,
      options: { mainLoopModel: 'claude-sonnet-4-6', tools: [] },
    }
    const cacheSafeParams = createCacheSafeParams({
      messages: bigMsgs,
      systemPrompt: asSystemPrompt(['You are helpful.']),
      userContext: {},
      systemContext: {},
      toolUseContext,
    })

    const compacted = await compactConversation(
      bigMsgs,
      toolUseContext,
      cacheSafeParams,
      true,
      undefined,
      true,
      undefined,
      { deps: mockDeps },
    )
    expect(apiCalls).toBe(2)
    expect(compacted.boundaryMarker.subtype).toBe('compact_boundary')
    expect(String(compacted.summaryMessages[0]!.message.content)).toContain(
      'Compacted after PTL head-trim retry.',
    )

    // Partial compaction ('from') preserves prefix verbatim and summarizes tail
    const partialRes = await partialCompactConversation(
      bigMsgs,
      bigMsgs[4]!,
      toolUseContext,
      cacheSafeParams,
      { direction: 'from', deps: mockDeps },
    )
    expect(partialRes.boundaryMarker.subtype).toBe('compact_boundary')
    expect(partialRes.summaryMessages.length).toBeGreaterThanOrEqual(1)

    // Circuit breaker: stops retrying after MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES (3)
    const failingDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel() {
        throw new Error('simulated upstream failure')
      },
    }
    const breakerRes = await autoCompactIfNeeded(
      bigMsgs,
      toolUseContext,
      cacheSafeParams,
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 't0',
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      },
      0,
      failingDeps,
    )
    expect(breakerRes.wasCompacted).toBe(false)
  })
})
