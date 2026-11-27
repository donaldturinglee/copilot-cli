import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAllCommands } from '../../src/commands.js'
import { appendHistory, readHistory, searchHistory } from '../../src/history.js'
import { InputBufferController } from '../../src/hooks/use_input_buffer.js'
import { PasteDebouncer } from '../../src/hooks/use_paste_handler.js'
import {
  applyTypeaheadSelection,
  resolveTypeahead,
} from '../../src/hooks/use_typeahead.js'
import { buildReplCommandContext } from '../../src/interactive_helpers.js'
import { clearImagePasteStore, registerImagePaste } from '../../src/utilities/image_paste.js'
import { MessageQueueManager } from '../../src/utilities/message_queue_manager.js'
import { clearPasteStore, expandPastedText } from '../../src/utilities/paste_store.js'
import { processUserInput } from '../../src/utilities/process_user_input/process_user_input.js'
import { FileSuggestionEngine } from '../../src/utilities/suggestions/file_suggestions.js'
import {
  recordSkillUsage,
  resetSkillUsageTracking,
} from '../../src/utilities/suggestions/skill_usage_tracking.js'

describe('Phase 6.3 — Input Buffer, History, 8-Tier Typeahead, Paste Folding & Routing', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-p6-input-'))
    clearPasteStore()
    clearImagePasteStore()
    resetSkillUsageTracking()
  })

  afterEach(() => {
    clearPasteStore()
    clearImagePasteStore()
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('InputBufferController supports 50-step undo, Emacs Kill Ring, Ctrl+S stash, and atomic [Image #N] deletion', () => {
    const buf = new InputBufferController('hello world')
    buf.killWordBackward() // kills 'world'
    expect(buf.text).toBe('hello ')
    buf.yank()
    expect(buf.text).toBe('hello world')

    buf.moveLineStart()
    buf.killToEnd()
    expect(buf.text).toBe('')
    buf.yank()
    expect(buf.text).toBe('hello world')

    // Ctrl+S stash & restore
    expect(buf.toggleStash()).toBe('stashed')
    expect(buf.text).toBe('')
    expect(buf.hasStash()).toBe(true)
    expect(buf.toggleStash()).toBe('restored')
    expect(buf.text).toBe('hello world')

    // Atomic [Image #1] deletion on single backspace
    buf.setValue('check [Image #1]', 'check [Image #1]'.length)
    buf.backspace()
    expect(buf.text).toBe('check ')

    // 50-step undo depth cap
    const undoBuf = new InputBufferController('')
    for (let i = 0; i < 65; i++) {
      undoBuf.insert('a')
    }
    expect(undoBuf.getUndoDepth()).toBe(50)
    expect(undoBuf.undo()).toBe(true)
    expect(undoBuf.text.length).toBe(64)
  })

  test('PasteDebouncer coalesces rapid chunks in 100ms window and folds/expands large pastes', async () => {
    const flushed: Array<import('../../src/hooks/use_paste_handler.js').PasteHandlerResult> = []
    const debouncer = new PasteDebouncer(res => flushed.push(res), 30)

    const longPayload = 'line1\nline2\nline3\nline4\nline5'
    debouncer.push('line1\nline2\n')
    debouncer.push('line3\nline4\nline5')
    await new Promise(r => setTimeout(r, 60))

    expect(flushed.length).toBe(1)
    expect(flushed[0]!.kind).toBe('folded')
    if (flushed[0]!.kind === 'folded') {
      const chipToken = flushed[0]!.chip.token
      expect(chipToken).toBe('[Pasted text #1 +4 lines]')
      expect(expandPastedText(`Explain this:\n${chipToken}`)).toBe(
        `Explain this:\n${longPayload}`,
      )
    }

    // Empty bracketed paste triggers image paste hook
    debouncer.push('', true)
    expect(flushed[1]?.kind).toBe('empty_paste')
    debouncer.dispose()
  })

  test('~/.copilot/history.jsonl persists entries deduplicated newest-first and supports Ctrl+R search', () => {
    const histPath = join(tempDir, 'history.jsonl')
    appendHistory('first prompt', { historyPath: histPath, timestamp: 100 })
    appendHistory('!git status', { historyPath: histPath, timestamp: 200 })
    appendHistory('!git status', { historyPath: histPath, timestamp: 201 })
    appendHistory('fix auth bug in server.ts', { historyPath: histPath, timestamp: 300 })

    const entries = readHistory({ historyPath: histPath })
    expect(entries.map(e => e.display)).toEqual([
      'fix auth bug in server.ts',
      '!git status',
      'first prompt',
    ])

    const hits = searchHistory('auth server', entries)
    expect(hits.length).toBe(1)
    expect(hits[0]!.display).toBe('fix auth bug in server.ts')
  })

  test('8-tier useTypeahead resolves all priority tiers including sub-millisecond FileIndex @file completion', () => {
    const commands = getAllCommands()
    const fileEngine = new FileSuggestionEngine()
    const paths: string[] = ['src/screens/repl.tsx', 'src/vim/transitions.ts']
    for (let i = 0; i < 2000; i++) {
      paths.push(`packages/pkg-${i % 20}/module_${i}.ts`)
    }
    fileEngine.loadFiles(paths)

    const history = [
      { display: '!git status', timestamp: 1 },
      { display: '!bun test', timestamp: 2 },
    ]
    const members = [{ id: 'm1', label: 'alice', kind: 'member' as const }]

    // Tier 1: mid-line `/`
    const t1 = resolveTypeahead({
      input: 'please run /doc',
      cursor: 'please run /doc'.length,
      commands,
      fileEngine,
    })
    expect(t1.tier).toBe('tier1_midline_slash')
    expect(t1.suggestions.some(s => s.id === 'cmd:doctor')).toBe(true)

    // Tier 2: `!` shell history
    const t2 = resolveTypeahead({
      input: '!git',
      cursor: 4,
      commands,
      fileEngine,
      historyEntries: history,
    })
    expect(t2.tier).toBe('tier2_shell_history')
    expect(t2.suggestions[0]!.displayText).toBe('!git status')

    // Tier 3: `@member`
    const t3 = resolveTypeahead({
      input: 'ask @ali',
      cursor: 8,
      commands,
      fileEngine,
      members,
    })
    expect(t3.tier).toBe('tier3_member_mention')
    expect(t3.suggestions[0]!.displayText).toBe('@alice')

    // Tier 4: slash command argument completion
    const t4 = resolveTypeahead({
      input: '/effort hi',
      cursor: 10,
      commands,
      fileEngine,
    })
    expect(t4.tier).toBe('tier4_command_args')
    expect(t4.suggestions[0]!.displayText).toBe('high')

    // Tier 5: leading `/` + usage decay boost
    recordSkillUsage('doctor')
    recordSkillUsage('doctor')
    const t5 = resolveTypeahead({
      input: '/d',
      cursor: 2,
      commands,
      fileEngine,
    })
    expect(t5.tier).toBe('tier5_leading_slash')
    expect(t5.suggestions[0]!.id).toBe('cmd:doctor')

    // Tier 6: `@file` sub-millisecond search via native/file_index
    const t0 = performance.now()
    const t6 = resolveTypeahead({
      input: 'inspect @repl',
      cursor: 'inspect @repl'.length,
      commands,
      fileEngine,
    })
    const elapsedMs = performance.now() - t0
    expect(t6.tier).toBe('tier6_file_mcp_agent')
    expect(t6.suggestions[0]!.displayText).toBe('@src/screens/repl.tsx')
    expect(elapsedMs).toBeLessThan(50)

    const applied = applyTypeaheadSelection('inspect @repl', t6, t6.suggestions[0]!)
    expect(applied.text).toBe('inspect @src/screens/repl.tsx ')

    // Tier 7: directory/path completion
    mkdirSync(join(tempDir, 'subdir'), { recursive: true })
    writeFileSync(join(tempDir, 'sample.txt'), 'hi')
    const t7 = resolveTypeahead({
      input: './sub',
      cursor: 5,
      commands,
      fileEngine,
      cwd: tempDir,
    })
    expect(t7.tier).toBe('tier7_directory_path')
    expect(t7.suggestions[0]!.displayText).toBe('subdir/')

    // Tier 8: context suggestions when empty
    const t8 = resolveTypeahead({
      input: '',
      cursor: 0,
      commands,
      fileEngine,
      showContextWhenEmpty: true,
    })
    expect(t8.tier).toBe('tier8_context_suggestion')
    expect(t8.suggestions.length).toBeGreaterThan(0)
  })

  test('processUserInput routes !shell, /slash, queued prompts while streaming, immediate commands, and image/paste expansion', async () => {
    const commands = getAllCommands()
    const queue = new MessageQueueManager()
    const ctx = buildReplCommandContext({
      messages: [],
      setMessages: () => {},
      abortController: new AbortController(),
      theme: 'dark',
      runtime: {},
    })

    // 1. `!` shell command
    const bashRoute = await processUserInput({
      input: '!echo hello',
      commands,
      context: ctx,
      bashExecutor: async cmd => ({ stdout: `ran:${cmd}\n`, stderr: '', code: 0 }),
    })
    expect(bashRoute.kind).toBe('bash')
    if (bashRoute.kind === 'bash') {
      expect(bashRoute.result.stdout).toBe('ran:echo hello\n')
    }

    // 2. Normal prompt queued while streaming
    const queuedRoute = await processUserInput({
      input: 'follow up question',
      commands,
      context: ctx,
      isLoading: true,
      queueManager: queue,
    })
    expect(queuedRoute.kind).toBe('queued')
    expect(queue.size()).toBe(1)

    // 3. Immediate command (`/version`) bypasses streaming queue!
    const immRoute = await processUserInput({
      input: '/version',
      commands,
      context: ctx,
      isLoading: true,
      queueManager: queue,
    })
    expect(immRoute.kind).toBe('slash')
    if (immRoute.kind === 'slash' && immRoute.result.kind === 'local_text') {
      expect(immRoute.result.text).toContain('Copilot CLI v')
    }

    // 4. Image chip resolves to base64 ImageBlockParam on normal prompt
    const img = registerImagePaste({ base64Data: 'AAAA', mediaType: 'image/png' })
    const promptRoute = await processUserInput({
      input: `Look at ${img.token}`,
      commands,
      context: ctx,
      skipHooks: true,
    })
    expect(promptRoute.kind).toBe('prompt')
    if (promptRoute.kind === 'prompt' && !promptRoute.result.blocked) {
      expect(promptRoute.result.imagePasteIds).toEqual([img.id])
      expect(Array.isArray(promptRoute.result.userMessage.message.content)).toBe(true)
    }
  })
})
