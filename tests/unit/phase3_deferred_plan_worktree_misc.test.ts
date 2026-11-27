import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import { getDefaultAppState } from '../../src/state/app_state_store.js'
import { asAnyTool, type ToolUseContext } from '../../src/tool.js'
import { AskUserQuestionTool } from '../../src/tools/ask_user_question_tool/ask_user_question_tool.js'
import { BriefTool } from '../../src/tools/brief_tool/brief_tool.js'
import { ConfigTool } from '../../src/tools/config_tool/config_tool.js'
import { EnterPlanModeTool } from '../../src/tools/enter_plan_mode_tool/enter_plan_mode_tool.js'
import { EnterWorktreeTool } from '../../src/tools/enter_worktree_tool/enter_worktree_tool.js'
import { ExitPlanModeV2Tool } from '../../src/tools/exit_plan_mode_tool/exit_plan_mode_v2_tool.js'
import { ExitWorktreeTool } from '../../src/tools/exit_worktree_tool/exit_worktree_tool.js'
import { NotebookEditTool } from '../../src/tools/notebook_edit_tool/notebook_edit_tool.js'
import { createSyntheticOutputTool } from '../../src/tools/synthetic_output_tool/synthetic_output_tool.js'
import { TodoWriteTool } from '../../src/tools/todo_write_tool/todo_write_tool.js'
import { ToolSearchTool } from '../../src/tools/tool_search_tool/tool_search_tool.js'
import {
  clearWebFetchCache,
  fetchUrlWithSafeRedirects,
  htmlToMarkdown,
  isPermittedRedirect,
  validateWebFetchUrl,
} from '../../src/tools/web_fetch_tool/utils.js'
import { WebFetchTool } from '../../src/tools/web_fetch_tool/web_fetch_tool.js'
import { WebSearchTool } from '../../src/tools/web_search_tool/web_search_tool.js'
import { getCwd } from '../../src/utilities/cwd.js'
import { execFileNoThrowWithCwd } from '../../src/utilities/exec_file_no_throw.js'
import { clearGitRootCachesForTesting, gitExe } from '../../src/utilities/git.js'
import { createUserMessage } from '../../src/utilities/messages.js'
import { clearAllPlanSlugs, getPlanFilePath } from '../../src/utilities/plans.js'
import {
  extractDiscoveredToolNames,
  getToolSearchMode,
  isToolSearchEnabled,
} from '../../src/utilities/tool_search.js'
import {
  restoreWorktreeSession,
  validateWorktreeSlug,
} from '../../src/utilities/worktree.js'

function createStatefulContext(tools = [
  asAnyTool(ToolSearchTool),
  asAnyTool(NotebookEditTool),
  asAnyTool(WebFetchTool),
  asAnyTool(WebSearchTool),
  asAnyTool(ConfigTool),
]): ToolUseContext {
  let state = getDefaultAppState()
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
    options: { tools },
  }
}

describe('Phase 3.6: ToolSearch, Plan Mode, Git Worktree, Web, Todo, StructuredOutput, Brief, Config', () => {
  let tempDir: string
  let prevCwd: string
  const origEnableToolSearch = process.env.ENABLE_TOOL_SEARCH
  const origConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    prevCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-p3-misc-'))
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, '.copilot-home')
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    setOriginalCwd(tempDir)
    setCwdState(tempDir)
    clearAllPlanSlugs()
    clearWebFetchCache()
    restoreWorktreeSession(null)
    clearGitRootCachesForTesting()
  })

  afterEach(() => {
    setOriginalCwd(prevCwd)
    setCwdState(prevCwd)
    if (origEnableToolSearch === undefined) {
      delete process.env.ENABLE_TOOL_SEARCH
    } else {
      process.env.ENABLE_TOOL_SEARCH = origEnableToolSearch
    }
    if (origConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = origConfigDir
    }
    restoreWorktreeSession(null)
    clearGitRootCachesForTesting()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('ToolSearch supports tst/tst-auto/standard modes, select:, weighted +required keyword search, and tool_reference discovery', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    expect(getToolSearchMode()).toBe('tst')
    const ctx = createStatefulContext()
    expect(isToolSearchEnabled('claude-sonnet-4-6', ctx.options!.tools!)).toBe(true)

    process.env.ENABLE_TOOL_SEARCH = 'false'
    expect(getToolSearchMode()).toBe('standard')
    expect(isToolSearchEnabled('claude-sonnet-4-6', ctx.options!.tools!)).toBe(false)

    process.env.ENABLE_TOOL_SEARCH = 'auto:5'
    expect(getToolSearchMode()).toBe('tst-auto')

    // Direct select: multi-tool loading
    const selectRes = await ToolSearchTool.call(
      { query: 'select:NotebookEdit,WebFetch', max_results: 5 },
      ctx,
      undefined,
      undefined,
    )
    expect(selectRes.data.matches).toEqual(['NotebookEdit', 'WebFetch'])

    const block = ToolSearchTool.mapToolResultToToolResultBlockParam(
      selectRes.data,
      'ts1',
    )
    const discovered = extractDiscoveredToolNames([
      createUserMessage({ content: [block] }),
    ])
    expect(discovered.has('NotebookEdit')).toBe(true)
    expect(discovered.has('WebFetch')).toBe(true)

    // Weighted keyword search with +required term
    const kwRes = await ToolSearchTool.call(
      { query: '+notebook jupyter', max_results: 5 },
      ctx,
      undefined,
      undefined,
    )
    expect(kwRes.data.matches).toContain('NotebookEdit')
    expect(kwRes.data.matches).not.toContain('WebFetch')
  })

  test('EnterPlanMode and ExitPlanMode transition modes, preserve prePlanMode, and read/write plan file', async () => {
    const ctx = createStatefulContext()
    ctx.setAppState!(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: 'acceptEdits',
      },
    }))

    const entered = await EnterPlanModeTool.call({}, ctx, undefined, undefined)
    expect(ctx.getAppState!().toolPermissionContext.mode).toBe('plan')
    expect(ctx.getAppState!().toolPermissionContext.prePlanMode).toBe('acceptEdits')

    const planPath = getPlanFilePath()
    expect(entered.data.planFilePath).toBe(planPath)
    writeFileSync(planPath, '# Plan\n1. Step one\n', 'utf8')

    // Reject entering plan mode again
    const dupEnter = await EnterPlanModeTool.validateInput!({}, ctx)
    expect(dupEnter.result).toBe(false)

    const exited = await ExitPlanModeV2Tool.call({}, ctx, undefined, undefined)
    expect(exited.data.plan).toContain('Step one')
    expect(ctx.getAppState!().toolPermissionContext.mode).toBe('acceptEdits')
  })

  test('Worktree slug validation and EnterWorktree/ExitWorktree lifecycle with fail-closed dirty check', async () => {
    // Path traversal & invalid slug rejection
    expect(validateWorktreeSlug('../escape').valid).toBe(false)
    expect(validateWorktreeSlug('a/b').valid).toBe(false)
    expect(validateWorktreeSlug('.hidden').valid).toBe(false)
    expect(validateWorktreeSlug('branch.lock').valid).toBe(false)
    expect(validateWorktreeSlug('feature-123').valid).toBe(true)

    // Initialize isolated temp git repository
    const repoDir = join(tempDir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    setOriginalCwd(repoDir)
    setCwdState(repoDir)
    clearGitRootCachesForTesting()

    await execFileNoThrowWithCwd(gitExe(), ['init'], { cwd: repoDir })
    await execFileNoThrowWithCwd(
      gitExe(),
      ['config', 'user.email', 'test@example.com'],
      { cwd: repoDir },
    )
    await execFileNoThrowWithCwd(
      gitExe(),
      ['config', 'user.name', 'Test User'],
      { cwd: repoDir },
    )
    writeFileSync(join(repoDir, 'README.md'), '# Repo\n', 'utf8')
    await execFileNoThrowWithCwd(gitExe(), ['add', '.'], { cwd: repoDir })
    await execFileNoThrowWithCwd(gitExe(), ['commit', '-m', 'init'], {
      cwd: repoDir,
    })

    const ctx = createStatefulContext()
    const entered = await EnterWorktreeTool.call(
      { name: 'exp-1' },
      ctx,
      undefined,
      undefined,
    )
    expect(entered.data.worktreeBranch).toBe('worktree-exp-1')
    expect(existsSync(entered.data.worktreePath)).toBe(true)
    expect(getCwd()).toBe(entered.data.worktreePath)

    // Create uncommitted file -> remove without discard_changes must fail closed
    writeFileSync(join(entered.data.worktreePath, 'dirty.txt'), 'uncommitted')
    let blockedError: unknown
    try {
      await ExitWorktreeTool.call(
        { action: 'remove', discard_changes: false },
        ctx,
        undefined,
        undefined,
      )
    } catch (err) {
      blockedError = err
    }
    expect(blockedError).toBeInstanceOf(Error)
    expect((blockedError as Error).message).toContain('discard_changes: true')

    // With discard_changes: true -> removes worktree and restores CWD
    const removed = await ExitWorktreeTool.call(
      { action: 'remove', discard_changes: true },
      ctx,
      undefined,
      undefined,
    )
    expect(removed.data.action).toBe('remove')
    expect(removed.data.discardedFiles).toBe(1)
    expect(getCwd()).toBe(repoDir)
    expect(existsSync(entered.data.worktreePath)).toBe(false)
  }, 15_000)

  test('WebFetch URL validation, safe redirects, LRU cache, turndown HTML->Markdown, and WebSearch validation', async () => {
    const upgraded = validateWebFetchUrl('http://example.com/docs')
    expect(upgraded.valid).toBe(true)
    if (upgraded.valid) expect(upgraded.url).toBe('https://example.com/docs')

    expect(validateWebFetchUrl('ftp://example.com').valid).toBe(false)
    expect(validateWebFetchUrl('https://user:pass@example.com').valid).toBe(false)

    expect(isPermittedRedirect('https://example.com/a', 'https://www.example.com/b')).toBe(true)
    expect(isPermittedRedirect('https://example.com/a', 'https://other.com/b')).toBe(false)

    const md = await htmlToMarkdown('<h1>Hello</h1><p>World <strong>bold</strong></p>')
    expect(md).toContain('# Hello')
    expect(md).toContain('**bold**')

    // Mock fetch: cross-host redirect returns explicit notice without following
    const crossHostRes = await fetchUrlWithSafeRedirects(
      'https://example.com/start',
      undefined,
      {
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example.org/phish' },
          })) as unknown as typeof fetch,
      },
    )
    expect(crossHostRes.redirectedToDifferentHost).toBe(
      'https://evil.example.org/phish',
    )

    // Mock fetch: LRU cache serves second identical request without hitting fetchImpl again
    let hits = 0
    const mockFetch = (async () => {
      hits++
      return new Response('<h2>Cached</h2>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }) as unknown as typeof fetch
    const first = await fetchUrlWithSafeRedirects(
      'https://example.com/page',
      undefined,
      { fetchImpl: mockFetch },
    )
    const second = await fetchUrlWithSafeRedirects(
      'https://example.com/page',
      undefined,
      { fetchImpl: mockFetch },
    )
    expect(hits).toBe(1)
    expect(first.content).toContain('## Cached')
    expect(second.content).toBe(first.content)

    // WebSearch mutual exclusion check
    const ctx = createStatefulContext()
    const invalidWs = await WebSearchTool.validateInput!(
      {
        query: 'typescript',
        allowed_domains: ['typescriptlang.org'],
        blocked_domains: ['spam.com'],
      },
      ctx,
    )
    expect(invalidWs.result).toBe(false)
  })

  test('AskUserQuestion, TodoWrite, StructuredOutput (Ajv), BriefTool, and ConfigTool behave per spec', async () => {
    const ctx = createStatefulContext()

    // AskUserQuestion duplicate label rejection
    expect(AskUserQuestionTool.requiresUserInteraction!()).toBe(true)
    const dupOpts = await AskUserQuestionTool.validateInput!(
      {
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            multiSelect: false,
            options: [
              { label: 'Same', description: 'a' },
              { label: 'Same', description: 'b' },
            ],
          },
        ],
      },
      ctx,
    )
    expect(dupOpts.result).toBe(false)

    // TodoWrite persists and auto-clears when all items completed
    await TodoWriteTool.call(
      {
        todos: [
          { content: 'Task 1', status: 'in_progress', activeForm: 'Doing 1' },
          { content: 'Task 2', status: 'pending', activeForm: 'Doing 2' },
        ],
      },
      ctx,
      undefined,
      undefined,
    )
    const todoKeys = Object.keys(ctx.getAppState!().todos)
    expect(todoKeys.length).toBe(1)
    expect(ctx.getAppState!().todos[todoKeys[0]!]!.length).toBe(2)

    await TodoWriteTool.call(
      {
        todos: [
          { content: 'Task 1', status: 'completed', activeForm: 'Doing 1' },
          { content: 'Task 2', status: 'completed', activeForm: 'Doing 2' },
        ],
      },
      ctx,
      undefined,
      undefined,
    )
    expect(ctx.getAppState!().todos[todoKeys[0]!]!).toEqual([])

    // StructuredOutput WeakMap-cached Ajv validator
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['answer'],
      additionalProperties: false,
    }
    const syntheticTool = createSyntheticOutputTool(schema)
    const invalidStruct = await syntheticTool.validateInput!(
      { answer: 'not-a-number' },
      ctx,
    )
    expect(invalidStruct.result).toBe(false)

    const validStruct = await syntheticTool.validateInput!(
      { answer: 42, tags: ['ok'] },
      ctx,
    )
    expect(validStruct.result).toBe(true)
    const structRes = await syntheticTool.call(
      { answer: 42, tags: ['ok'] },
      ctx,
      undefined,
      undefined,
    )
    expect(structRes.newMessages?.[0]?.type).toBe('attachment')

    // BriefTool
    const briefRes = await BriefTool.call(
      { message: 'Progress update', status: 'proactive' },
      ctx,
      undefined,
      undefined,
    )
    expect(briefRes.data.message).toBe('Progress update')

    // ConfigTool get/set
    const setRes = await ConfigTool.call(
      { setting: 'effortLevel', value: 'high' },
      ctx,
      undefined,
      undefined,
    )
    expect(setRes.data.success).toBe(true)
    const getRes = await ConfigTool.call(
      { setting: 'effortLevel' },
      ctx,
      undefined,
      undefined,
    )
    expect(getRes.data.value).toBe('high')
  })
})
