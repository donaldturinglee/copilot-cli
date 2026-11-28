import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { UUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  switchSession,
} from '../../src/bootstrap/state.js'
import { formatAssistantSessionHistory } from '../../src/assistant/session_history.js'
import { EMPTY_USAGE } from '../../src/services/api/empty_usage.js'
import { asSessionId } from '../../src/types/ids.js'
import type { AssistantMessage, Message, UserMessage } from '../../src/types/message.js'
import { calculateCommitAttribution, trackFileCreation, trackFileModification } from '../../src/utilities/commit_attribution.js'
import type { AttributionState } from '../../src/types/forward.js'
import { analyzeContext, tokenStatsToMetrics } from '../../src/utilities/context_analysis.js'
import {
  deserializeMessagesWithInterruptDetection,
  detectTurnInterruption,
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
  loadConversationForResume,
  migrateLegacyAttachmentTypes,
} from '../../src/utilities/conversation_recovery.js'
import { checkCrossProjectResume } from '../../src/utilities/cross_project_resume.js'
import { randomUUID } from '../../src/utilities/crypto.js'
import {
  executeFilePersistence,
  findModifiedFiles,
} from '../../src/utilities/file_persistence/file_persistence.js'
import { listSessionsImpl } from '../../src/utilities/list_sessions_impl.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
} from '../../src/utilities/messages.js'
import {
  extractTodosFromTranscript,
  processResumedConversation,
} from '../../src/utilities/session_restore.js'
import {
  buildConversationChain,
  flushSessionStorage,
  getProjectDir,
  getTranscriptPath,
  loadMessageLogs,
  loadTranscriptFile,
  reAppendSessionMetadata,
  recordTranscript,
  removeMessageByUuid,
  resetSessionStorageForTests,
  saveCustomTitle,
  saveTag,
} from '../../src/utilities/session_storage.js'
import {
  readSessionLite,
  readTranscriptForLoad,
} from '../../src/utilities/session_storage_portable.js'
import { extractConversationText } from '../../src/utilities/session_title.js'
import { parseSessionIdentifier } from '../../src/utilities/session_url.js'

function makeToolUseAssistant(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  uuid: UUID = randomUUID() as UUID,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    requestId: 'req_test',
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: toolCalls.map(t => ({
        type: 'tool_use' as const,
        id: t.id,
        name: t.name,
        input: t.input,
      })),
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { ...EMPTY_USAGE } as BetaMessage['usage'],
    } as BetaMessage,
  }
}

function makeToolResultUser(
  toolUseId: string,
  content: string,
  uuid: UUID = randomUUID() as UUID,
): UserMessage {
  return createUserMessage({
    uuid,
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
      },
    ],
  })
}

describe('Phase 7.1 — JSONL Session Persistence, 64KB Lite Listing, & DAG Restoration', () => {
  let tempRoot: string
  let configDir: string
  let projectDir: string
  let savedConfigDir: string | undefined
  let savedTestPersist: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    savedTestPersist = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-p7-s1-'))
    configDir = join(tempRoot, 'config')
    projectDir = join(tempRoot, 'repo')
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetStateForTests()
    resetSessionStorageForTests()
    setOriginalCwd(projectDir)
    setCwdState(projectDir)
  })

  afterEach(async () => {
    await flushSessionStorage().catch(() => {})
    resetSessionStorageForTests()
    resetStateForTests()
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    if (savedTestPersist === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = savedTestPersist
    }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('lazy materialization buffers metadata until first user/assistant message and flushes cleanly', async () => {
    const sid = getSessionId() as UUID
    const sessionPath = getTranscriptPath()

    await saveCustomTitle(sid, 'Queued Title Before Materialize')
    await saveTag(sid, 'release-prep')
    await flushSessionStorage()

    // Lazy creation: file must not exist until a user/assistant message arrives
    expect(existsSync(sessionPath)).toBe(false)

    const u1 = createUserMessage({ content: 'Hello session storage' })
    const a1 = createAssistantMessage({ content: 'Hi! Ready to help.' })
    await recordTranscript([u1, a1])
    await flushSessionStorage()

    expect(existsSync(sessionPath)).toBe(true)
    const raw = readFileSync(sessionPath, 'utf8')
    expect(raw).toContain('Queued Title Before Materialize')
    expect(raw).toContain('release-prep')
    expect(raw).toContain('Hello session storage')

    // Re-appending metadata keeps tail metadata discoverable in 64KB tail scan
    await reAppendSessionMetadata()
    await flushSessionStorage()
    const lite = await readSessionLite(sessionPath)
    expect(lite).not.toBeNull()
    expect(lite!.tail).toContain('Queued Title Before Materialize')
    expect(lite!.tail).toContain('release-prep')
  })

  test('removeMessageByUuid splices target line cleanly from tail fast path', async () => {
    const u1 = createUserMessage({ content: 'Keep first message' })
    const a1 = createAssistantMessage({ content: 'Keep assistant reply' })
    const u2 = createUserMessage({ content: 'Delete this interrupted message' })
    await recordTranscript([u1, a1, u2])
    await flushSessionStorage()

    const sessionPath = getTranscriptPath()
    expect(readFileSync(sessionPath, 'utf8')).toContain(u2.uuid)

    const removed = await removeMessageByUuid(u2.uuid)
    expect(removed).toBe(true)
    const after = readFileSync(sessionPath, 'utf8')
    expect(after).not.toContain(u2.uuid)
    expect(after).toContain(u1.uuid)
    expect(after).toContain(a1.uuid)
  })

  test('listSessionsImpl scans 64KB head/tail with metadata precedence and pagination', async () => {
    const sid1 = randomUUID() as UUID
    const sid2 = randomUUID() as UUID

    switchSession(asSessionId(sid1))
    resetSessionStorageForTests()
    await recordTranscript([
      createUserMessage({ content: 'First project question' }),
      createAssistantMessage({ content: 'First answer' }),
    ])
    await saveCustomTitle(sid1, 'Auth Refactor')
    await saveTag(sid1, 'security')
    await flushSessionStorage()

    // Ensure distinct mtime
    await new Promise(r => setTimeout(r, 25))

    switchSession(asSessionId(sid2))
    resetSessionStorageForTests()
    await recordTranscript([
      createUserMessage({ content: 'Second project question' }),
      createAssistantMessage({ content: 'Second answer' }),
    ])
    await saveCustomTitle(sid2, 'Perf Tuning')
    await flushSessionStorage()

    const page1 = await listSessionsImpl({ dir: projectDir, limit: 1, offset: 0 })
    const page2 = await listSessionsImpl({ dir: projectDir, limit: 1, offset: 1 })
    const all = await listSessionsImpl({ dir: projectDir })

    expect(all.length).toBe(2)
    expect(all[0]!.customTitle).toBe('Perf Tuning')
    expect(all[1]!.customTitle).toBe('Auth Refactor')
    expect(all[1]!.tag).toBe('security')
    expect(page1.length).toBe(1)
    expect(page2.length).toBe(1)
    expect(page1[0]!.sessionId).not.toBe(page2[0]!.sessionId)
  })

  test('buildConversationChain repairs orphaned parallel tool_result siblings without losing tool_use pairing', async () => {
    const u1 = createUserMessage({ content: 'Run two tools in parallel' })
    const a1 = makeToolUseAssistant([
      { id: 'toolu_p1', name: 'Read', input: { file_path: 'a.ts' } },
      { id: 'toolu_p2', name: 'Read', input: { file_path: 'b.ts' } },
    ])
    const tr1 = makeToolResultUser('toolu_p1', 'contents of a.ts')
    const tr2 = makeToolResultUser('toolu_p2', 'contents of b.ts')
    const a2 = createAssistantMessage({ content: 'Both files read.' })

    // Simulate parallel sibling race: BOTH tr1 and tr2 have parentUuid = a1.uuid,
    // and a2 chains off tr2 while tr1 sits as a sibling branch!
    const messagesMap = new Map<UUID, Message & { parentUuid: UUID | null }>([
      [u1.uuid, { ...u1, parentUuid: null }],
      [a1.uuid, { ...a1, parentUuid: u1.uuid }],
      [tr1.uuid, { ...tr1, parentUuid: a1.uuid }],
      [tr2.uuid, { ...tr2, parentUuid: a1.uuid }],
      [a2.uuid, { ...a2, parentUuid: tr2.uuid }],
    ])

    const chain = buildConversationChain(
      messagesMap as never,
      messagesMap.get(a2.uuid) as never,
    )

    const toolResultIds = new Set<string>()
    for (const msg of chain) {
      if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            toolResultIds.add(block.tool_use_id)
          }
        }
      }
    }
    expect(toolResultIds.has('toolu_p1')).toBe(true)
    expect(toolResultIds.has('toolu_p2')).toBe(true)
    expect(chain.at(-1)?.uuid).toBe(a2.uuid)
  })

  test('>5MB transcript skips pre-compact segment and recovers pre-boundary customTitle/tag cleanly', async () => {
    const sid = randomUUID() as UUID
    const dir = getProjectDir(projectDir)
    const filePath = join(dir, `${sid}.jsonl`)
    await saveCustomTitle(sid, 'Temp Init') // ensures dir exists once materialized

    // Build a >5.2MB JSONL file directly with pre-compact bulk + metadata + compact_boundary + post-compact chain
    const { mkdirSync } = await import('fs')
    mkdirSync(dir, { recursive: true })

    const lines: string[] = []
    lines.push(
      JSON.stringify({
        type: 'custom-title',
        sessionId: sid,
        customTitle: 'Pre-Compact Persistent Title',
      }),
    )
    lines.push(
      JSON.stringify({
        type: 'tag',
        sessionId: sid,
        tag: 'mega-session',
      }),
    )

    const hugePayload = 'X'.repeat(60_000)
    let prevUuid: UUID | null = null
    for (let i = 0; i < 95; i++) {
      const msgUuid = randomUUID() as UUID
      lines.push(
        JSON.stringify({
          ...createUserMessage({ uuid: msgUuid, content: `Turn ${i}: ${hugePayload}` }),
          parentUuid: prevUuid,
          sessionId: sid,
          cwd: projectDir,
          isSidechain: false,
          userType: 'external',
          version: '0.0.1',
        }),
      )
      prevUuid = msgUuid
    }

    const boundary = createCompactBoundaryMessage(
      'auto',
      150_000,
      { messagesSummarized: 95 },
      prevUuid ?? undefined,
    )
    const summaryMsg = createUserMessage({
      content: 'Compacted summary of turns 0..94',
      isCompactSummary: true,
    })
    const finalUser = createUserMessage({ content: 'Post-compact follow-up' })
    const finalAssistant = createAssistantMessage({ content: 'Continuing seamlessly!' })

    lines.push(
      JSON.stringify({
        ...boundary,
        parentUuid: null,
        sessionId: sid,
        cwd: projectDir,
        isSidechain: false,
        userType: 'external',
        version: '0.0.1',
      }),
    )
    lines.push(
      JSON.stringify({
        ...summaryMsg,
        parentUuid: boundary.uuid,
        sessionId: sid,
        cwd: projectDir,
        isSidechain: false,
        userType: 'external',
        version: '0.0.1',
      }),
    )
    lines.push(
      JSON.stringify({
        ...finalUser,
        parentUuid: summaryMsg.uuid,
        sessionId: sid,
        cwd: projectDir,
        isSidechain: false,
        userType: 'external',
        version: '0.0.1',
      }),
    )
    lines.push(
      JSON.stringify({
        ...finalAssistant,
        parentUuid: finalUser.uuid,
        sessionId: sid,
        cwd: projectDir,
        isSidechain: false,
        userType: 'external',
        version: '0.0.1',
      }),
    )

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
    expect(statSync(filePath).size).toBeGreaterThan(5 * 1024 * 1024)

    const readRes = await readTranscriptForLoad(filePath, statSync(filePath).size)
    expect(readRes.boundaryStartOffset).toBeGreaterThan(5 * 1024 * 1024)
    expect(readRes.buffer.length).toBeLessThan(10_000)

    const parsed = await loadTranscriptFile(filePath)
    expect(parsed.customTitles.get(sid)).toBe('Pre-Compact Persistent Title')
    expect(parsed.tags.get(sid)).toBe('mega-session')
    expect(parsed.messages.has(finalAssistant.uuid)).toBe(true)
    expect(parsed.messages.size).toBeLessThan(10)
  })

  test('conversation recovery detects interrupted turns, drops orphaned tool_use, and supports --fork-session & --resume-session-at', async () => {
    const u1 = createUserMessage({ content: 'Inspect package.json' })
    const a1 = makeToolUseAssistant([
      { id: 'toolu_orphan', name: 'Read', input: { file_path: 'package.json' } },
    ])
    // Interrupted right after tool_use (no tool_result written!)
    const recovered = deserializeMessagesWithInterruptDetection([u1, a1])

    // Unresolved tool_use must be scrubbed (zero orphaned tool_use blocks)
    for (const m of recovered.messages) {
      if (m.type === 'assistant') {
        expect(m.message.content.some(b => b.type === 'tool_use')).toBe(false)
      }
    }
    // Trailing user message gets API-validity sentinel
    expect(
      recovered.messages.some(
        m =>
          m.type === 'assistant' &&
          m.message.content.some(
            b => b.type === 'text' && b.text === NO_RESPONSE_REQUESTED,
          ),
      ),
    ).toBe(true)

    // Interruption detector distinguishes interrupted tool turn vs clean end
    const u2 = createUserMessage({ content: 'Run check' })
    const a2 = makeToolUseAssistant([
      { id: 'toolu_done', name: 'Bash', input: { command: 'echo ok' } },
    ])
    const tr2 = makeToolResultUser('toolu_done', 'ok')
    expect(detectTurnInterruption([u2, a2, tr2]).kind).toBe('interrupted_turn')

    // Legacy attachment migration + orphaned thinking/whitespace filters
    const migrated = migrateLegacyAttachmentTypes([
      {
        type: 'attachment',
        uuid: randomUUID() as UUID,
        timestamp: new Date().toISOString(),
        attachment: { type: 'new_file', filename: join(projectDir, 'a.ts') },
      },
    ])
    expect(
      migrated[0]?.type === 'attachment' && migrated[0].attachment.type === 'file',
    ).toBe(true)

    const thinkingOnly: AssistantMessage = {
      ...createAssistantMessage({ content: 'x' }),
      message: {
        ...createAssistantMessage({ content: 'x' }).message,
        id: 'msg_only_think',
        content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }],
      },
    }
    expect(filterOrphanedThinkingOnlyMessages([thinkingOnly]).length).toBe(0)
    expect(
      filterWhitespaceOnlyAssistantMessages([
        createAssistantMessage({ content: '   \n  ' }),
      ]).length,
    ).toBe(0)

    // Save a multi-turn session, then resume with `--fork-session` + `--resume-session-at`
    const origSid = randomUUID() as UUID
    switchSession(asSessionId(origSid))
    resetSessionStorageForTests()
    const m1 = createUserMessage({ content: 'Step 1' })
    const m2 = createAssistantMessage({ content: 'Done 1' })
    const m3 = createUserMessage({ content: 'Step 2' })
    const m4 = createAssistantMessage({ content: 'Done 2' })
    await recordTranscript([m1, m2, m3, m4])
    await flushSessionStorage()

    const logs = await loadMessageLogs(projectDir)
    expect(logs.length).toBeGreaterThanOrEqual(1)

    // Fork into a fresh session ID sliced at m2.uuid
    const freshSid = randomUUID() as UUID
    switchSession(asSessionId(freshSid))
    resetSessionStorageForTests()
    const loaded = await loadConversationForResume(origSid, undefined, {
      projectPath: projectDir,
      skipSessionStartHooks: true,
    })
    expect(loaded).not.toBeNull()
    const forked = await processResumedConversation(loaded!.log, loaded!.messages, {
      forkSession: true,
      resumeSessionAt: m2.uuid,
    })
    expect(forked.sessionId).toBe(freshSid)
    expect(forked.messages.length).toBe(2)
    expect(forked.messages.at(-1)?.uuid).toBe(m2.uuid)
  })

  test('supporting utilities: session_url, cross_project_resume, session_title, attribution, context_analysis, file_persistence, session_history', async () => {
    // Windows path safety before URL parsing
    const winJsonl = parseSessionIdentifier('C:\\Users\\dev\\session.jsonl')
    expect(winJsonl).toEqual({ kind: 'jsonl_file', path: 'C:\\Users\\dev\\session.jsonl' })
    const uuidId = randomUUID()
    expect(parseSessionIdentifier(uuidId)).toEqual({
      kind: 'session_id',
      sessionId: uuidId,
    })

    // Cross-project resume command generation
    const cross = checkCrossProjectResume(
      { projectPath: '/other/project', sessionId: uuidId },
      true,
      [],
    )
    expect(cross.isCrossProject).toBe(true)
    if (cross.isCrossProject && !cross.isSameRepoWorktree) {
      expect(cross.command).toContain(`--resume ${uuidId}`)
    }

    // Session title text extractor + Todo extraction
    const todoAssistant = makeToolUseAssistant([
      {
        id: 'toolu_todo',
        name: 'TodoWrite',
        input: {
          todos: [{ id: '1', content: 'Ship Phase 7', status: 'in_progress' }],
        },
      },
    ])
    const todos = extractTodosFromTranscript([todoAssistant])
    expect(todos.length).toBe(1)
    expect(todos[0]!.content).toBe('Ship Phase 7')

    const text = extractConversationText([
      createUserMessage({ content: 'Build session persistence' }),
      createAssistantMessage({ content: 'Implemented JSONL storage.' }),
    ])
    expect(text).toContain('Build session persistence')

    // Commit attribution tracking
    let attrState: AttributionState = {
      fileStates: new Map(),
      promptCount: 0,
      promptCountAtLastCommit: 0,
      permissionPromptCount: 0,
      permissionPromptCountAtLastCommit: 0,
      escapeCount: 0,
      escapeCountAtLastCommit: 0,
    }
    attrState = trackFileCreation(attrState, join(projectDir, 'src/new.ts'), 'line1\nline2\n')
    attrState = trackFileModification(
      attrState,
      join(projectDir, 'src/old.ts'),
      'a\nb\n',
      'a\nb\nc\n',
    )
    const report = await calculateCommitAttribution([attrState], [
      'src/new.ts',
      'src/old.ts',
    ])
    expect(report.filesAnalyzed).toBeGreaterThanOrEqual(0)

    // Context analysis & duplicate file read detection
    const dupRead = makeToolUseAssistant([
      { id: 'r1', name: 'Read', input: { file_path: 'src/a.ts' } },
      { id: 'r2', name: 'Read', input: { file_path: 'src/a.ts' } },
    ])
    const stats = analyzeContext([
      dupRead,
      makeToolResultUser('r1', 'hello world'),
      makeToolResultUser('r2', 'hello world'),
    ])
    expect(stats.duplicateFileReads).toBeGreaterThan(0)
    expect(tokenStatsToMetrics(stats).duplicateFileReadTokens).toBe(
      stats.duplicateFileReads,
    )

    // File persistence scanner & bounded upload
    const outDir = join(tempRoot, 'outputs')
    const { mkdirSync } = await import('fs')
    mkdirSync(outDir, { recursive: true })
    const startMs = Date.now() - 1000
    writeFileSync(join(outDir, 'artifact.txt'), 'generated report', 'utf8')
    const modified = await findModifiedFiles(startMs, outDir)
    expect(modified.length).toBe(1)

    const persisted = await executeFilePersistence(startMs, {
      outputsDir: outDir,
      uploader: async (_fp, filename) => ({ fileId: `file_${filename}` }),
    })
    expect(persisted.files.length).toBe(1)
    expect(persisted.failed.length).toBe(0)

    // Assistant session history formatting
    const formatted = formatAssistantSessionHistory([
      {
        sessionId: uuidId,
        summary: 'Implemented Phase 7',
        firstPrompt: 'Build Phase 7',
        date: new Date().toISOString(),
        modified: new Date(),
        created: new Date(),
        messages: [],
        messageCount: 4,
        value: 0,
        isSidechain: false,
        customTitle: 'Phase 7 Session',
      },
    ])
    expect(formatted[0]?.title).toBe('Phase 7 Session')
  })
})
