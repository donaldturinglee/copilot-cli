import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { UUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  resetStateForTests,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from '../../src/bootstrap/state.js'
import { CONTEXT_SECURITY_COMMANDS } from '../../src/commands/context_security_commands.js'
import { buildReplCommandContext } from '../../src/interactive_helpers.js'
import { query } from '../../src/query.js'
import { productionDeps, type QueryDeps } from '../../src/query/deps.js'
import { QueryEngine } from '../../src/query_engine.js'
import { findRelevantMemories } from '../../src/memdir/find_relevant_memories.js'
import { getAutoMemPath } from '../../src/memdir/paths.js'
import { EMPTY_USAGE } from '../../src/services/api/empty_usage.js'
import {
  clearCompactWarningSuppression,
  compactWarningStore,
} from '../../src/services/compact/compact_warning_state.js'
import {
  executeExtractMemories,
  resetExtractMemoriesForTesting,
} from '../../src/services/extract_memories/extract_memories.js'
import { resetSessionMemoryState } from '../../src/services/session_memory/session_memory_utils.js'
import { createAppStateStore } from '../../src/state/app_state_store.js'
import { FileEditTool } from '../../src/tools/file_edit_tool/file_edit_tool.js'
import { FileReadTool } from '../../src/tools/file_read_tool/file_read_tool.js'
import { FileWriteTool } from '../../src/tools/file_write_tool/file_write_tool.js'
import type { LocalCommandCall } from '../../src/types/command.js'
import { asSessionId } from '../../src/types/ids.js'
import type { AssistantMessage, Message } from '../../src/types/message.js'
import { clearMemoryFileCaches } from '../../src/utilities/claudemd.js'
import { loadConversationForResume } from '../../src/utilities/conversation_recovery.js'
import { randomUUID } from '../../src/utilities/crypto.js'
import { fileHistoryRewind } from '../../src/utilities/file_history.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utilities/messages.js'
import { processResumedConversation } from '../../src/utilities/session_restore.js'
import {
  flushSessionStorage,
  getTranscriptPath,
  resetSessionStorageForTests,
} from '../../src/utilities/session_storage.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'
import { asSystemPrompt } from '../../src/utilities/system_prompt_type.js'

function toolUseAssistant(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): AssistantMessage {
  const uuid = randomUUID() as UUID
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    requestId: 'req_e2e',
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: calls.map(c => ({
        type: 'tool_use' as const,
        id: c.id,
        name: c.name,
        input: c.input,
      })),
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { ...EMPTY_USAGE } as BetaMessage['usage'],
    } as BetaMessage,
  }
}

describe('Phase 7 End-to-End Integration — Session Persistence, Rewind Rollback, Auto/Manual Compaction, and Persistent Memory', () => {
  let tempRoot: string
  let configDir: string
  let repoDir: string
  let savedConfigDir: string | undefined
  let savedTestPersist: string | undefined
  let savedAutoWindow: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    savedTestPersist = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    savedAutoWindow = process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-p7-e2e-'))
    configDir = join(tempRoot, 'config')
    repoDir = join(tempRoot, 'repo')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    delete process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW
    resetStateForTests()
    resetSettingsCache()
    clearMemoryFileCaches()
    getAutoMemPath.cache.clear?.()
    resetSessionStorageForTests()
    resetSessionMemoryState()
    resetExtractMemoriesForTesting()
    clearCompactWarningSuppression()
    setIsInteractive(true)
    setOriginalCwd(repoDir)
    setCwdState(repoDir)
    setProjectRoot(repoDir)
  })

  afterEach(async () => {
    await flushSessionStorage().catch(() => {})
    getAutoMemPath.cache.clear?.()
    clearMemoryFileCaches()
    resetSessionStorageForTests()
    resetSessionMemoryState()
    resetExtractMemoriesForTesting()
    clearCompactWarningSuppression()
    resetSettingsCache()
    resetStateForTests()
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    if (savedTestPersist === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = savedTestPersist
    }
    if (savedAutoWindow === undefined) {
      delete process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW
    } else {
      process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW = savedAutoWindow
    }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('edits multiple files across persisted QueryEngine turns, then /rewind restores exact disk files and conversation state, and --resume recovers transcript cleanly', async () => {
    const fileA = join(repoDir, 'a.ts')
    const fileB = join(repoDir, 'b.ts')
    writeFileSync(fileA, 'export const a = "original"\n', 'utf8')

    const store = createAppStateStore()
    let modelStep = 0

    const mockDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel() {
        modelStep++
        if (modelStep === 1) {
          // Turn 1: Read a.ts then Edit a.ts
          yield toolUseAssistant([
            { id: 't_read_a', name: 'Read', input: { file_path: fileA } },
          ])
        } else if (modelStep === 2) {
          yield toolUseAssistant([
            {
              id: 't_edit_a',
              name: 'Edit',
              input: {
                file_path: fileA,
                old_string: 'original',
                new_string: 'turn1_modified',
              },
            },
          ])
        } else if (modelStep === 3) {
          yield createAssistantMessage({ content: 'Updated a.ts in turn 1.' })
        } else if (modelStep === 4) {
          // Turn 2: Create b.ts and edit a.ts again
          yield toolUseAssistant([
            {
              id: 't_write_b',
              name: 'Write',
              input: { file_path: fileB, content: 'export const b = 2\n' },
            },
            {
              id: 't_edit_a2',
              name: 'Edit',
              input: {
                file_path: fileA,
                old_string: 'turn1_modified',
                new_string: 'turn2_modified',
              },
            },
          ])
        } else {
          yield createAssistantMessage({ content: 'Created b.ts and updated a.ts in turn 2.' })
        }
      },
    }

    const engine = new QueryEngine({
      cwd: repoDir,
      tools: [FileReadTool, FileEditTool, FileWriteTool],
      commands: [],
      mcpClients: [],
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      getAppState: () => store.getState(),
      setAppState: updater => store.setState(updater),
      isNonInteractiveSession: false,
      deps: mockDeps,
    })

    const turn1Uuid = randomUUID() as UUID
    for await (const _ev of engine.submitMessage('Turn 1: update a.ts', { uuid: turn1Uuid })) {
      // drain
    }
    expect(readFileSync(fileA, 'utf8')).toBe('export const a = "turn1_modified"\n')

    const turn2Uuid = randomUUID() as UUID
    for await (const _ev of engine.submitMessage('Turn 2: create b.ts and update a.ts', { uuid: turn2Uuid })) {
      // drain
    }
    expect(readFileSync(fileA, 'utf8')).toBe('export const a = "turn2_modified"\n')
    expect(readFileSync(fileB, 'utf8')).toBe('export const b = 2\n')

    await flushSessionStorage()
    const sessionPath = getTranscriptPath()
    expect(existsSync(sessionPath)).toBe(true)

    // Rewind code & conversation back to turn2Uuid checkpoint -> restores a.ts to turn1_modified & unlinks b.ts
    await fileHistoryRewind(
      updater =>
        store.setState(prev => ({ ...prev, fileHistory: updater(prev.fileHistory) })),
      turn2Uuid,
    )
    expect(readFileSync(fileA, 'utf8')).toBe('export const a = "turn1_modified"\n')
    expect(existsSync(fileB)).toBe(false)

    // Rewind all the way back to turn1Uuid -> restores original a.ts!
    await fileHistoryRewind(
      updater =>
        store.setState(prev => ({ ...prev, fileHistory: updater(prev.fileHistory) })),
      turn1Uuid,
    )
    expect(readFileSync(fileA, 'utf8')).toBe('export const a = "original"\n')

    // Resume persisted JSONL transcript into a new session fork and confirm intact chain
    const origSid = getSessionId()
    const newSid = randomUUID()
    switchSession(asSessionId(newSid))
    resetSessionStorageForTests()
    const loaded = await loadConversationForResume(origSid, undefined, {
      projectPath: repoDir,
      skipSessionStartHooks: true,
    })
    expect(loaded).not.toBeNull()
    const resumed = await processResumedConversation(loaded!.log, loaded!.messages, {
      forkSession: true,
    })
    expect(resumed.messages.length).toBeGreaterThanOrEqual(4)
  })

  test('low COPILOT_CLI_AUTO_COMPACT_WINDOW triggers seamless automatic compaction inside query(), and manual /compact compacts cleanly', async () => {
    process.env.COPILOT_CLI_AUTO_COMPACT_WINDOW = '36000'
    // Effective = 16,000; auto threshold = 3,000 tokens

    const longHistory: Message[] = []
    for (let i = 0; i < 8; i++) {
      longHistory.push(
        createUserMessage({ content: `Turn ${i}: ` + 'context '.repeat(400) }),
        createAssistantMessage({ content: `Reply ${i}: ` + 'analysis '.repeat(400) }),
      )
    }

    let summaryCalls = 0
    let mainCalls = 0
    const mockDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel(params) {
        if (params.options.querySource === 'compact') {
          summaryCalls++
          yield createAssistantMessage({
            content: '<summary>1. Primary Request: Complete Phase 7.\n8. Current Work: Verifying autocompact.</summary>',
          })
          return
        }
        mainCalls++
        yield createAssistantMessage({
          content: 'Continued seamlessly after automatic compaction!',
        })
      },
      autocompact: async (msgs, ctx, cacheSafe, qs, tracking, snip) => {
        const { autoCompactIfNeeded } = await import(
          '../../src/services/compact/auto_compact.js'
        )
        return autoCompactIfNeeded(msgs, ctx, cacheSafe, qs, tracking, snip, mockDeps)
      },
    }

    const yielded: Message[] = []
    for await (const ev of query({
      messages: longHistory,
      systemPrompt: asSystemPrompt(['You are helpful.']),
      userContext: {},
      systemContext: {},
      canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
      toolUseContext: {
        abortController: new AbortController(),
        messages: longHistory,
        options: { mainLoopModel: 'claude-sonnet-4-6', tools: [] },
      },
      querySource: 'repl_main_thread',
      deps: mockDeps,
    })) {
      if (ev.type === 'system' || ev.type === 'user' || ev.type === 'assistant') {
        yielded.push(ev)
      }
    }

    expect(summaryCalls).toBe(1)
    expect(mainCalls).toBe(1)
    expect(
      yielded.some(m => m.type === 'system' && m.subtype === 'compact_boundary'),
    ).toBe(true)
    expect(
      yielded.some(
        m =>
          m.type === 'assistant' &&
          m.message.content.some(
            b =>
              b.type === 'text' &&
              b.text.includes('Continued seamlessly after automatic compaction!'),
          ),
      ),
    ).toBe(true)

    // Manual `/compact` slash command produces compact_boundary and suppresses token warning
    const compactCmd = CONTEXT_SECURITY_COMMANDS.find(
      c => c.name === 'compact',
    ) as Extract<(typeof CONTEXT_SECURITY_COMMANDS)[number], { type: 'local' }>
    const { call: runCompact } = await compactCmd.load()
    let currentMessages = [...longHistory]
    const cmdContext = buildReplCommandContext({
      messages: currentMessages,
      setMessages: updater => {
        currentMessages = updater(currentMessages)
      },
      abortController: new AbortController(),
      theme: 'dark',
      runtime: {},
    })
    const cmdResult = await (runCompact as LocalCommandCall)(
      'preserve API details',
      cmdContext,
    )
    expect(cmdResult.type).toBe('text')
    expect(currentMessages[0]?.type).toBe('system')
    expect(
      currentMessages[0]?.type === 'system' &&
        currentMessages[0].subtype === 'compact_boundary',
    ).toBe(true)
    expect(compactWarningStore.getState()).toBe(true)
  })

  test('multi-turn session persists memory via extractMemories, new session recalls it, and sandbox blocks out-of-bounds project write', async () => {
    const memDir = getAutoMemPath()
    const targetMemFile = join(memDir, 'deployment_pref.md')
    const forbiddenProjectFile = join(repoDir, 'pwned.ts')
    let attemptedOutOfBounds = false
    let extractTurn = 0

    const mockDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel() {
        extractTurn++
        if (extractTurn === 1) {
          // Forked extractor tries BOTH a forbidden project write and a valid memdir write!
          yield toolUseAssistant([
            {
              id: 'tu_bad_write',
              name: 'Write',
              input: { file_path: forbiddenProjectFile, content: 'blocked!' },
            },
            {
              id: 'tu_good_mem',
              name: 'Write',
              input: {
                file_path: targetMemFile,
                content:
                  '---\nname: Deployment preference\ndescription: Always deploy to staging before prod\ntype: feedback\n---\nNever skip staging deployments.\n',
              },
            },
          ])
        } else {
          attemptedOutOfBounds = true
          yield createAssistantMessage({ content: 'Memory persisted.' })
        }
      },
    }

    const convo: Message[] = [
      createUserMessage({ content: 'Always deploy to staging before production.' }),
      createAssistantMessage({ content: 'Got it, I will always deploy to staging first.' }),
    ]

    const notifications: Message[] = []
    await executeExtractMemories(
      {
        messages: convo,
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        toolUseContext: {
          abortController: new AbortController(),
          messages: convo,
          options: {
            mainLoopModel: 'claude-sonnet-4-6',
            tools: [FileReadTool, FileEditTool, FileWriteTool],
          },
        },
      },
      msg => notifications.push(msg),
      { force: true, deps: mockDeps },
    )

    expect(attemptedOutOfBounds).toBe(true)
    // Out-of-bounds project write MUST be blocked by sandbox!
    expect(existsSync(forbiddenProjectFile)).toBe(false)
    // Valid memdir write MUST succeed!
    expect(existsSync(targetMemFile)).toBe(true)
    expect(notifications.some(n => n.type === 'system' && n.subtype === 'memory_saved')).toBe(true)

    // Start a brand-new session and verify relevance recall finds the persisted memory
    switchSession(asSessionId(randomUUID()))
    const recalled = await findRelevantMemories(
      'Ready to deploy to production?',
      memDir,
      new AbortController().signal,
      [],
      new Set(),
      async () =>
        ({
          id: 'msg_recall',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ selected_memories: ['deployment_pref.md'] }),
            },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { ...EMPTY_USAGE } as BetaMessage['usage'],
        }) as BetaMessage,
    )
    expect(recalled.length).toBe(1)
    expect(recalled[0]!.path).toBe(targetMemFile)
    expect(readFileSync(recalled[0]!.path, 'utf8')).toContain('Never skip staging deployments')
  })
})
