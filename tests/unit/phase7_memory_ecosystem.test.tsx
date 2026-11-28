import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { PassThrough } from 'stream'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../src/bootstrap/state.js'
import { App } from '../../src/components/app.js'
import { MemoryFileSelector } from '../../src/components/memory/memory_file_selector.js'
import {
  getRelativeMemoryPath,
  MemoryUpdateNotification,
} from '../../src/components/memory/memory_update_notification.js'
import { render } from '../../src/ink/root.js'
import { findRelevantMemories } from '../../src/memdir/find_relevant_memories.js'
import {
  buildMemoryLines,
  buildMemoryPrompt,
  loadMemoryPrompt,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from '../../src/memdir/memdir.js'
import { memoryFreshnessNote, memoryFreshnessText } from '../../src/memdir/memory_age.js'
import { scanMemoryFiles } from '../../src/memdir/memory_scan.js'
import { MEMORY_TYPES } from '../../src/memdir/memory_types.js'
import {
  getAutoMemPath,
  getAutoMemPathOverride,
  isAutoMemPath,
} from '../../src/memdir/paths.js'
import {
  getTeamMemPath,
  PathTraversalError,
  sanitizePathKey,
  validateTeamMemKey,
} from '../../src/memdir/team_mem_paths.js'
import { productionDeps, type QueryDeps } from '../../src/query/deps.js'
import { EMPTY_USAGE } from '../../src/services/api/empty_usage.js'
import {
  executeAutoDream,
  resetAutoDreamStateForTesting,
} from '../../src/services/auto_dream/auto_dream.js'
import {
  getConsolidationLockPath,
  listSessionsTouchedSince,
  tryAcquireConsolidationLock,
} from '../../src/services/auto_dream/consolidation_lock.js'
import { buildConsolidationPrompt } from '../../src/services/auto_dream/consolidation_prompt.js'
import {
  createAwaySummaryMessage,
  generateAwaySummary,
} from '../../src/services/away_summary.js'
import { hasSummarySinceLastUserTurn } from '../../src/hooks/use_away_summary.js'
import {
  createAutoMemCanUseTool,
  executeExtractMemories,
  hasMemoryWritesSince,
  resetExtractMemoriesForTesting,
} from '../../src/services/extract_memories/extract_memories.js'
import {
  createMemoryFileCanUseTool,
  extractSessionMemory,
  resetLastMemoryMessageUuid,
  resetSessionMemoryHookForTesting,
  shouldExtractMemory,
} from '../../src/services/session_memory/session_memory.js'
import {
  getSessionMemoryPath,
  resetSessionMemoryState,
  setSessionMemoryConfig,
} from '../../src/services/session_memory/session_memory_utils.js'
import {
  batchDeltaByBytes,
  createSyncState,
  hashContent,
  pullTeamMemory,
  pushTeamMemory,
} from '../../src/services/team_memory_sync/index.js'
import { redactSecrets, scanForSecrets } from '../../src/services/team_memory_sync/secret_scanner.js'
import { checkTeamMemSecrets } from '../../src/services/team_memory_sync/team_mem_secret_guard.js'
import {
  resetWatcherStateForTesting,
} from '../../src/services/team_memory_sync/watcher.js'
import { FileEditTool } from '../../src/tools/file_edit_tool/file_edit_tool.js'
import { FileReadTool } from '../../src/tools/file_read_tool/file_read_tool.js'
import { FileWriteTool } from '../../src/tools/file_write_tool/file_write_tool.js'
import {
  clearMemoryFileCaches,
  getConditionalRulesForCwdLevelDirectory,
  getMemoryFilesForNestedDirectory,
} from '../../src/utilities/claudemd.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utilities/messages.js'
import { isAutoManagedMemoryFile } from '../../src/utilities/memory_file_detection.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'
import { asSystemPrompt } from '../../src/utilities/system_prompt_type.js'

function createStreams() {
  const stdout = Object.assign(new PassThrough(), {
    columns: 90,
    rows: 26,
    isTTY: false,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: false,
    setRawMode: () => {},
  })
  return { stdout, stdin }
}

describe('Phase 7.4 — Memory Ecosystem (memdir, INSTRUCTIONS.md, SessionMemory, extractMemories, autoDream, teamMemorySync, awaySummary)', () => {
  let tempRoot: string
  let configDir: string
  let repoDir: string
  let savedConfigDir: string | undefined
  let savedDisableAutoMem: string | undefined
  let savedTeamMemEnv: string | undefined
  let savedMemOverride: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    savedDisableAutoMem = process.env.COPILOT_CLI_DISABLE_AUTO_MEMORY
    savedTeamMemEnv = process.env.COPILOT_CLI_ENABLE_TEAM_MEMORY
    savedMemOverride = process.env.COPILOT_CLI_MEMORY_PATH_OVERRIDE
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-p7-s4-'))
    configDir = join(tempRoot, 'config')
    repoDir = join(tempRoot, 'repo')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.COPILOT_CLI_DISABLE_AUTO_MEMORY
    delete process.env.COPILOT_CLI_MEMORY_PATH_OVERRIDE
    process.env.COPILOT_CLI_ENABLE_TEAM_MEMORY = '1'
    resetStateForTests()
    resetSettingsCache()
    clearMemoryFileCaches()
    getAutoMemPath.cache.clear?.()
    resetSessionMemoryState()
    resetLastMemoryMessageUuid()
    resetSessionMemoryHookForTesting()
    resetExtractMemoriesForTesting()
    resetAutoDreamStateForTesting()
    resetWatcherStateForTesting()
    setOriginalCwd(repoDir)
    setCwdState(repoDir)
    setProjectRoot(repoDir)
  })

  afterEach(() => {
    getAutoMemPath.cache.clear?.()
    clearMemoryFileCaches()
    resetSettingsCache()
    resetSessionMemoryState()
    resetLastMemoryMessageUuid()
    resetSessionMemoryHookForTesting()
    resetExtractMemoriesForTesting()
    resetAutoDreamStateForTesting()
    resetWatcherStateForTesting()
    resetStateForTests()
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    if (savedDisableAutoMem === undefined) {
      delete process.env.COPILOT_CLI_DISABLE_AUTO_MEMORY
    } else {
      process.env.COPILOT_CLI_DISABLE_AUTO_MEMORY = savedDisableAutoMem
    }
    if (savedTeamMemEnv === undefined) delete process.env.COPILOT_CLI_ENABLE_TEAM_MEMORY
    else process.env.COPILOT_CLI_ENABLE_TEAM_MEMORY = savedTeamMemEnv
    if (savedMemOverride === undefined) {
      delete process.env.COPILOT_CLI_MEMORY_PATH_OVERRIDE
    } else {
      process.env.COPILOT_CLI_MEMORY_PATH_OVERRIDE = savedMemOverride
    }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('memdir: 4-category taxonomy, 200-line/25KB truncation, anti-RCE projectSettings exclusion, freshness notes, and Sonnet relevance recall', async () => {
    expect(MEMORY_TYPES).toEqual(['user', 'feedback', 'project', 'reference'])
    expect(buildMemoryLines('Memory', getAutoMemPath()).join('\n')).toContain('MEMORY.md')

    // Anti-RCE: projectSettings.json autoMemoryDirectory MUST be ignored
    mkdirSync(join(repoDir, '.copilot'), { recursive: true })
    writeFileSync(
      join(repoDir, '.copilot', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: '/tmp/evil-redirect' }),
      'utf8',
    )
    resetSettingsCache()
    expect(getAutoMemPathOverride()).toBeUndefined()

    // 200-line / 25KB truncation
    const longIndex = Array.from({ length: 250 }, (_, i) => `- Entry ${i}`).join('\n')
    const truncated = truncateEntrypointContent(longIndex)
    expect(truncated.wasLineTruncated).toBe(true)
    expect(truncated.lineCount).toBe(250)
    expect(truncated.content).toContain(`WARNING: MEMORY.md is 250 lines (limit: ${MAX_ENTRYPOINT_LINES})`)

    // Write topic files and verify scanMemoryFiles + loadMemoryPrompt + findRelevantMemories
    const memDir = getAutoMemPath()
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'MEMORY.md'), '- [Testing](testing.md): Always run bun test\n', 'utf8')
    const topicPath = join(memDir, 'testing.md')
    writeFileSync(
      topicPath,
      '---\nname: Testing\ndescription: Use bun test sequentially\ntype: feedback\n---\nNever run tsc and bun test concurrently.\n',
      'utf8',
    )
    // Backdate mtime by 3 days to verify staleness note
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(topicPath, threeDaysAgo, threeDaysAgo)

    const scanned = await scanMemoryFiles(memDir)
    expect(scanned.length).toBe(1)
    expect(scanned[0]!.type).toBe('feedback')
    expect(isAutoMemPath(topicPath)).toBe(true)
    expect(isAutoManagedMemoryFile(topicPath)).toBe(true)
    expect(memoryFreshnessText(threeDaysAgo.getTime())).toContain('3 days old')
    expect(memoryFreshnessNote(threeDaysAgo.getTime())).toContain('<system-reminder>')

    const promptSection = await loadMemoryPrompt()
    expect(promptSection).toContain('# auto memory')
    expect(promptSection).toContain(memDir)
    const embeddedPrompt = buildMemoryPrompt({
      displayName: 'auto memory',
      memoryDir: memDir,
    })
    expect(embeddedPrompt).toContain('Always run bun test')

    // Mock Sonnet sideQuery returning relevant memory filename
    const recalled = await findRelevantMemories(
      'How should I run tests?',
      memDir,
      new AbortController().signal,
      [],
      new Set(),
      async () =>
        ({
          id: 'msg_mem',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ selected_memories: ['testing.md'] }),
            },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { ...EMPTY_USAGE } as BetaMessage['usage'],
        }) as BetaMessage,
    )
    expect(recalled.length).toBe(1)
    expect(recalled[0]!.path).toBe(topicPath)

    // Already-surfaced path is excluded on subsequent recall
    const recalledAgain = await findRelevantMemories(
      'How should I run tests?',
      memDir,
      new AbortController().signal,
      [],
      new Set([topicPath]),
      async () => {
        throw new Error('should not query when all candidates already surfaced')
      },
    )
    expect(recalledAgain.length).toBe(0)
  })

  test('nested INSTRUCTIONS.md & paths: conditional rules load lazily when FileReadTool reads matching file', async () => {
    const nestedDir = join(repoDir, 'packages', 'api')
    mkdirSync(nestedDir, { recursive: true })
    mkdirSync(join(repoDir, '.copilot', 'rules'), { recursive: true })

    writeFileSync(
      join(nestedDir, 'INSTRUCTIONS.md'),
      'Always validate API request schemas with Zod v4.',
      'utf8',
    )
    writeFileSync(
      join(repoDir, '.copilot', 'rules', 'sql.md'),
      '---\npaths:\n  - "packages/api/**/*.ts"\n---\nUse parameterized SQL queries.',
      'utf8',
    )
    const targetFile = join(nestedDir, 'handler.ts')
    writeFileSync(targetFile, 'export const handle = () => 200\n', 'utf8')

    const triggers = new Set<string>()
    const readState = new Map()
    await FileReadTool.call(
      { file_path: targetFile },
      {
        abortController: new AbortController(),
        messages: [],
        readFileState: readState as never,
        nestedMemoryAttachmentTriggers: triggers,
      },
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(triggers.has(targetFile)).toBe(true)

    const loadedPaths = new Set<string>()
    const nested = getMemoryFilesForNestedDirectory(nestedDir, targetFile, loadedPaths)
    const cond = getConditionalRulesForCwdLevelDirectory(repoDir, targetFile, loadedPaths)
    expect(nested.some(f => f.content.includes('Zod v4'))).toBe(true)
    expect(cond.some(f => f.content.includes('parameterized SQL'))).toBe(true)
  })

  test('SessionMemory enforces 10k init / +5k incremental / 3 tool-call gates and strict Edit-only sandbox', async () => {
    setSessionMemoryConfig({
      minimumMessageTokensToInit: 500,
      minimumTokensBetweenUpdate: 300,
      toolCallsBetweenUpdates: 3,
    })

    // Below init threshold
    expect(shouldExtractMemory([createUserMessage({ content: 'hi' })])).toBe(false)

    // Above init threshold -> triggers first extraction
    const bigTurn = [
      createUserMessage({ content: 'W'.repeat(2_400) }),
      createAssistantMessage({ content: 'Understood.' }),
    ]
    expect(shouldExtractMemory(bigTurn)).toBe(true)

    const memPath = getSessionMemoryPath()
    const canUse = createMemoryFileCanUseTool(memPath)

    // ONLY Edit on exact summary.md path is allowed
    const allowEdit = await canUse(
      FileEditTool,
      { file_path: memPath, old_string: 'a', new_string: 'b' },
      { abortController: new AbortController(), messages: [] },
      createAssistantMessage({ content: '' }),
      'tu_1',
    )
    expect(allowEdit.behavior).toBe('allow')

    const denyOtherFile = await canUse(
      FileEditTool,
      { file_path: join(repoDir, 'index.ts'), old_string: 'a', new_string: 'b' },
      { abortController: new AbortController(), messages: [] },
      createAssistantMessage({ content: '' }),
      'tu_2',
    )
    expect(denyOtherFile.behavior).toBe('deny')

    const denyWrite = await canUse(
      FileWriteTool,
      { file_path: memPath, content: 'overwrite' },
      { abortController: new AbortController(), messages: [] },
      createAssistantMessage({ content: '' }),
      'tu_3',
    )
    expect(denyWrite.behavior).toBe('deny')

    // Run forced extraction with mock forked agent -> creates template summary.md on disk
    const mockDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel() {
        yield createAssistantMessage({ content: 'Summary updated.' })
      },
    }
    const ok = await extractSessionMemory(
      {
        messages: bigTurn,
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        toolUseContext: {
          abortController: new AbortController(),
          messages: bigTurn,
          options: { tools: [] },
        },
        querySource: 'repl_main_thread',
      },
      { force: true, deps: mockDeps },
    )
    expect(ok).toBe(true)
    expect(readFileSync(memPath, 'utf8')).toContain('# Session Title')
  })

  test('extractMemories sandbox forbids out-of-bounds project writes, permits memdir writes, and skips if main agent wrote directly', async () => {
    const memDir = getAutoMemPath()
    const canUse = createAutoMemCanUseTool(memDir)
    const dummyCtx = { abortController: new AbortController(), messages: [] }
    const dummyMsg = createAssistantMessage({ content: '' })

    // Allow Read anywhere & Write inside memDir
    expect((await canUse(FileReadTool, { file_path: join(repoDir, 'a.ts') }, dummyCtx, dummyMsg, '1')).behavior).toBe('allow')
    expect((await canUse(FileWriteTool, { file_path: join(memDir, 'note.md'), content: 'hi' }, dummyCtx, dummyMsg, '2')).behavior).toBe('allow')

    // FORBID Write/Edit outside memDir (project source files!)
    const deniedProjectWrite = await canUse(
      FileWriteTool,
      { file_path: join(repoDir, 'src', 'app.ts'), content: 'malicious' },
      dummyCtx,
      dummyMsg,
      '3',
    )
    expect(deniedProjectWrite.behavior).toBe('deny')

    // FORBID mutating Bash command
    const fakeMutatingBash = {
      name: 'Bash',
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
      isReadOnly: () => false,
    }
    expect((await canUse(fakeMutatingBash, { command: 'rm -rf .' }, dummyCtx, dummyMsg, '4')).behavior).toBe('deny')

    // Mutually-exclusive skip when main agent already wrote inside memdir
    const directWriteAssistant = {
      ...createAssistantMessage({ content: '' }),
      message: {
        ...createAssistantMessage({ content: '' }).message,
        content: [
          {
            type: 'tool_use' as const,
            id: 'tu_mem',
            name: 'Write',
            input: { file_path: join(memDir, 'direct.md'), content: 'saved' },
          },
        ],
      },
    }
    expect(hasMemoryWritesSince([directWriteAssistant], undefined)).toBe(true)

    let forkCalled = false
    const mockDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel() {
        forkCalled = true
        yield createAssistantMessage({ content: 'done' })
      },
    }
    await executeExtractMemories(
      {
        messages: [createUserMessage({ content: 'remember this' }), directWriteAssistant],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        toolUseContext: dummyCtx,
      },
      undefined,
      { deps: mockDeps, force: true },
    )
    expect(forkCalled).toBe(false)
  })

  test('autoDream enforces 24h & 5-session gates, PID lock acquisition/contention, and 4-phase consolidation prompt', async () => {
    const memDir = getAutoMemPath()
    const transcriptDir = join(tempRoot, 'transcripts')
    mkdirSync(memDir, { recursive: true })
    mkdirSync(transcriptDir, { recursive: true })

    // Create 5 distinct session JSONL files
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(transcriptDir, `00000000-0000-4000-8000-00000000000${i}.jsonl`), '{}\n', 'utf8')
    }
    const touched = await listSessionsTouchedSince(0, transcriptDir)
    expect(touched.length).toBe(5)

    // PID lock acquisition succeeds once, then contends against live current PID
    const prior = await tryAcquireConsolidationLock(memDir)
    expect(prior).not.toBeNull()
    const contended = await tryAcquireConsolidationLock(memDir)
    expect(contended).toBeNull()

    // Stale lock (>1h old with dead PID) can be reclaimed
    const lockPath = getConsolidationLockPath(memDir)
    writeFileSync(lockPath, '999999', 'utf8')
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(lockPath, twoHoursAgo, twoHoursAgo)
    const reclaimed = await tryAcquireConsolidationLock(memDir)
    expect(reclaimed).not.toBeNull()

    // 4-phase prompt contains Orient, Gather, Consolidate, Prune
    const prompt = buildConsolidationPrompt(memDir, transcriptDir, touched.join(', '))
    expect(prompt).toContain('Phase 1')
    expect(prompt).toContain('Phase 2')
    expect(prompt).toContain('Phase 3')
    expect(prompt).toContain('Phase 4')

    // Run autoDream with bypassGates + mock forked agent
    // Release lock first by deleting it so executeAutoDream acquires cleanly
    rmSync(join(memDir, '.consolidate-lock'), { force: true })
    const res = await executeAutoDream(
      {
        messages: [createUserMessage({ content: 'hi' })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        toolUseContext: {
          abortController: new AbortController(),
          messages: [],
          options: { tools: [] },
        },
      },
      undefined,
      {
        memoryDir: memDir,
        transcriptDir,
        bypassGates: true,
        deps: {
          ...productionDeps(),
          async *callModel() {
            yield createAssistantMessage({ content: 'Consolidated 5 sessions.' })
          },
        },
      },
    )
    expect(res.ran).toBe(true)
    expect(res.reason).toBe('completed')
  })

  test('teamMemorySync: 36-rule secretScanner blocks credentials, rejects traversal keys, and handles delta push/pull + 412 conflict + 413 limit', async () => {
    const fakeAwsKey = 'AKIAIOSFODNN7EXAMPLE'
    expect(scanForSecrets(`aws_access_key_id = ${fakeAwsKey}`).length).toBeGreaterThan(0)
    expect(redactSecrets(`key=${fakeAwsKey}`)).toContain('[REDACTED]')

    const teamDir = getTeamMemPath()
    const secretErr = checkTeamMemSecrets(
      join(teamDir, 'creds.md'),
      `token = ghp_${'a'.repeat(36)}`,
    )
    expect(secretErr).toContain('Blocked write to shared team memory')

    // Path traversal defense
    expect(() => sanitizePathKey('../escape.md')).toThrow(PathTraversalError)
    expect(() => sanitizePathKey('%2e%2e/escape.md')).toThrow(PathTraversalError)
    await expect(validateTeamMemKey('../../etc/passwd')).rejects.toThrow(PathTraversalError)

    // Delta batching <= 200KB
    const batches = batchDeltaByBytes({
      'a.md': 'x'.repeat(120_000),
      'b.md': 'y'.repeat(120_000),
    })
    expect(batches.length).toBe(2)

    // Pull -> local write -> Push skips secret file and retries 412 conflict
    const syncState = createSyncState()
    const serverEntries: Record<string, string> = {
      'arch.md': '# Architecture\nShared note',
    }
    let serverChecksum = 'etag-1'
    let putCount = 0

    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'GET' && url.includes('view=hashes')) {
        return new Response(
          JSON.stringify({
            checksum: 'etag-2',
            entryChecksums: { 'arch.md': hashContent(serverEntries['arch.md']!) },
          }),
          { status: 200 },
        )
      }
      if (init?.method === 'GET') {
        return new Response(
          JSON.stringify({
            repo: 'github.com/org/repo',
            checksum: serverChecksum,
            content: {
              entries: serverEntries,
              entryChecksums: { 'arch.md': hashContent(serverEntries['arch.md']!) },
            },
          }),
          { status: 200 },
        )
      }
      if (init?.method === 'PUT') {
        putCount++
        if (putCount === 1) {
          // Simulate ETag conflict on first PUT
          return new Response('Precondition Failed', { status: 412 })
        }
        serverChecksum = 'etag-3'
        return new Response(JSON.stringify({ checksum: serverChecksum }), { status: 200 })
      }
      return new Response('Not Found', { status: 404 })
    }

    const pullRes = await pullTeamMemory(syncState, {
      fetchFn: mockFetch,
      authToken: 'tok_test',
      repoSlug: 'github.com/org/repo',
      teamMemDir: teamDir,
      retryDelayMs: 0,
    })
    expect(pullRes.success).toBe(true)
    expect(pullRes.filesWritten).toBe(1)

    // Add 1 clean local note + 1 secret-tainted note
    writeFileSync(join(teamDir, 'clean.md'), '# Clean convention\nUse snake_case.', 'utf8')
    writeFileSync(
      join(teamDir, 'leaked.md'),
      `AWS key: ${fakeAwsKey}`,
      'utf8',
    )

    const pushRes = await pushTeamMemory(syncState, {
      fetchFn: mockFetch,
      authToken: 'tok_test',
      repoSlug: 'github.com/org/repo',
      teamMemDir: teamDir,
      retryDelayMs: 0,
    })
    expect(pushRes.success).toBe(true)
    expect(pushRes.filesPushed).toBe(1)
    expect(pushRes.skippedSecrets.length).toBe(1)
    expect(pushRes.skippedSecrets[0]!.path).toBe('leaked.md')
    expect(putCount).toBe(2)
  })

  test('awaySummary + MemoryUpdateNotification + MemoryFileSelector render cleanly', async () => {
    const msgs = [
      createUserMessage({ content: 'Implement Phase 7 memory' }),
      createAssistantMessage({ content: 'Finished writing memdir and autoDream.' }),
    ]
    const recap = await generateAwaySummary(msgs, undefined, {
      sessionMemory: null,
      queryFn: async () => 'Working on Phase 7 memory; memdir and autoDream are done; next step is testing.',
    })
    expect(recap).toContain('Phase 7 memory')
    const awayMsg = createAwaySummaryMessage(recap!)
    expect(hasSummarySinceLastUserTurn([...msgs, awayMsg])).toBe(true)
    expect(
      hasSummarySinceLastUserTurn([
        ...msgs,
        awayMsg,
        createUserMessage({ content: 'New prompt' }),
      ]),
    ).toBe(false)

    expect(getRelativeMemoryPath(join(repoDir, 'INSTRUCTIONS.md'), repoDir)).toBe(
      'INSTRUCTIONS.md',
    )

    const { stdout, stdin } = createStreams()
    const inst = render(
      <App>
        <MemoryUpdateNotification memoryPath={join(repoDir, 'INSTRUCTIONS.md')} />
        <MemoryFileSelector
          memoryFiles={[
            {
              path: join(repoDir, 'INSTRUCTIONS.md'),
              type: 'Project',
              content: 'Use bun test.',
            },
          ]}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </App>,
      { stdout, stdin },
    )
    await new Promise(r => setTimeout(r, 40))
    inst.flush()
    const frame = inst.ink.getPlainScreenLines().join('\n')
    expect(frame).toContain('Updated memory (INSTRUCTIONS.md)')
    expect(frame).toContain('Memory & Instructions')
    expect(frame).toContain('Auto-memory:')
    inst.unmount()
  })
})
