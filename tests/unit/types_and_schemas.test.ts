import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { z } from 'zod/v4'
import type { QuerySource } from '../../src/constants/query_source.js'
import type { Continue, Terminal } from '../../src/query/transitions.js'
import {
  type CommandBase,
  getCommandName,
  isCommandEnabled,
} from '../../src/types/command.js'
import type { FileSuggestionCommandInput } from '../../src/types/file_suggestion.js'
import { asAgentId } from '../../src/types/ids.js'
import { type Entry, type LogOption, sortLogs } from '../../src/types/logs.js'
import type {
  AssistantMessage,
  CollapsedReadSearchGroup,
  CompactMetadata,
  Message,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  RenderableMessage,
  RequestStartEvent,
  SystemCompactBoundaryMessage,
  SystemMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../src/types/message.js'
import type { QueueOperationMessage } from '../../src/types/message_queue_types.js'
import type {
  NotebookCell,
  NotebookCellOutput,
  NotebookContent,
} from '../../src/types/notebook.js'
import {
  EXTERNAL_PERMISSION_MODES,
  type PermissionRule,
} from '../../src/types/permissions.js'
import {
  getPluginErrorMessage,
  type PluginError,
} from '../../src/types/plugin.js'
import type { StatusLineCommandInput } from '../../src/types/status_line.js'
import {
  type EditablePromptInputMode,
  getImagePasteIds,
  isValidImagePaste,
  type PromptInputMode,
} from '../../src/types/text_input_types.js'
import type {
  AgentToolProgress,
  BashProgress,
  McpProgress,
  ShellProgress,
  ToolProgressData,
} from '../../src/types/tools.js'
import type { DeepImmutable, Permutations } from '../../src/types/utils.js'
import { lazySchema } from '../../src/utilities/lazy_schema.js'
import { semanticBoolean } from '../../src/utilities/semantic_boolean.js'
import { semanticNumber } from '../../src/utilities/semantic_number.js'

const SAMPLE_UUID = '550e8400-e29b-41d4-a716-446655440000' as UUID

describe('Step 0.2 — Reconstructed pure types & runtime helpers', () => {
  test('sortLogs orders by modified desc then created desc', () => {
    const base = {
      date: '2026-01-01',
      messages: [],
      value: 0,
      firstPrompt: 'hi',
      messageCount: 1,
      isSidechain: false,
    }
    const a: LogOption = {
      ...base,
      value: 1,
      created: new Date('2026-01-01T10:00:00Z'),
      modified: new Date('2026-01-02T10:00:00Z'),
    }
    const b: LogOption = {
      ...base,
      value: 2,
      created: new Date('2026-01-01T12:00:00Z'),
      modified: new Date('2026-01-02T10:00:00Z'),
    }
    const c: LogOption = {
      ...base,
      value: 3,
      created: new Date('2026-01-01T09:00:00Z'),
      modified: new Date('2026-01-03T10:00:00Z'),
    }

    const sorted = sortLogs([a, b, c])
    expect(sorted.map(x => x.value)).toEqual([3, 2, 1])
  })

  test('command helpers resolve userFacingName and isEnabled defaults', () => {
    const cmd1: CommandBase = { name: 'help', description: 'Show help' }
    expect(getCommandName(cmd1)).toBe('help')
    expect(isCommandEnabled(cmd1)).toBe(true)

    const cmd2: CommandBase = {
      name: 'plugin:deploy',
      description: 'Deploy',
      userFacingName: () => 'deploy',
      isEnabled: () => false,
    }
    expect(getCommandName(cmd2)).toBe('deploy')
    expect(isCommandEnabled(cmd2)).toBe(false)
  })

  test('getPluginErrorMessage formats every discriminated PluginError variant', () => {
    const errors: PluginError[] = [
      { type: 'generic-error', source: 's', error: 'boom' },
      {
        type: 'path-not-found',
        source: 's',
        path: '/x',
        component: 'skills',
      },
      {
        type: 'git-auth-failed',
        source: 's',
        gitUrl: 'https://x.git',
        authType: 'https',
      },
      {
        type: 'git-timeout',
        source: 's',
        gitUrl: 'https://x.git',
        operation: 'clone',
      },
      {
        type: 'network-error',
        source: 's',
        url: 'https://x',
        details: '503',
      },
      {
        type: 'manifest-parse-error',
        source: 's',
        manifestPath: 'plugin.json',
        parseError: 'invalid json',
      },
      {
        type: 'manifest-validation-error',
        source: 's',
        manifestPath: 'plugin.json',
        validationErrors: ['missing name'],
      },
      {
        type: 'plugin-not-found',
        source: 's',
        pluginId: 'foo',
        marketplace: 'official',
      },
      {
        type: 'marketplace-not-found',
        source: 's',
        marketplace: 'custom',
        availableMarketplaces: [],
      },
      {
        type: 'marketplace-load-failed',
        source: 's',
        marketplace: 'custom',
        reason: 'timeout',
      },
      {
        type: 'mcp-config-invalid',
        source: 's',
        plugin: 'p',
        serverName: 'srv',
        validationError: 'bad url',
      },
      {
        type: 'mcp-server-suppressed-duplicate',
        source: 's',
        plugin: 'p',
        serverName: 'srv',
        duplicateOf: 'plugin:other',
      },
      {
        type: 'lsp-config-invalid',
        source: 's',
        plugin: 'p',
        serverName: 'ts',
        validationError: 'no ext',
      },
      {
        type: 'hook-load-failed',
        source: 's',
        plugin: 'p',
        hookPath: 'hooks.json',
        reason: 'syntax',
      },
      {
        type: 'component-load-failed',
        source: 's',
        plugin: 'p',
        component: 'agents',
        path: 'a.md',
        reason: 'io',
      },
      {
        type: 'mcpb-download-failed',
        source: 's',
        plugin: 'p',
        url: 'https://x.mcpb',
        reason: '404',
      },
      {
        type: 'mcpb-extract-failed',
        source: 's',
        plugin: 'p',
        mcpbPath: 'x.mcpb',
        reason: 'corrupt',
      },
      {
        type: 'mcpb-invalid-manifest',
        source: 's',
        plugin: 'p',
        mcpbPath: 'x.mcpb',
        validationError: 'bad',
      },
      {
        type: 'lsp-server-start-failed',
        source: 's',
        plugin: 'p',
        serverName: 'ts',
        reason: 'ENOENT',
      },
      {
        type: 'lsp-server-crashed',
        source: 's',
        plugin: 'p',
        serverName: 'ts',
        exitCode: 1,
      },
      {
        type: 'lsp-server-crashed',
        source: 's',
        plugin: 'p',
        serverName: 'ts',
        exitCode: null,
        signal: 'SIGKILL',
      },
      {
        type: 'lsp-request-timeout',
        source: 's',
        plugin: 'p',
        serverName: 'ts',
        method: 'hover',
        timeoutMs: 5000,
      },
      {
        type: 'lsp-request-failed',
        source: 's',
        plugin: 'p',
        serverName: 'ts',
        method: 'hover',
        error: 'failed',
      },
      {
        type: 'marketplace-blocked-by-policy',
        source: 's',
        marketplace: 'bad',
        blockedByBlocklist: true,
        allowedSources: [],
      },
      {
        type: 'dependency-unsatisfied',
        source: 's',
        plugin: 'p',
        dependency: 'dep',
        reason: 'not-enabled',
      },
      {
        type: 'plugin-cache-miss',
        source: 's',
        plugin: 'p',
        installPath: '/cache/p',
      },
    ]

    for (const err of errors) {
      const msg = getPluginErrorMessage(err)
      expect(typeof msg).toBe('string')
      expect(msg.length).toBeGreaterThan(0)
    }
  })

  test('textInputTypes image paste helpers filter empty and non-image items', () => {
    expect(isValidImagePaste({ id: 1, type: 'text', content: 'abc' })).toBe(
      false,
    )
    expect(isValidImagePaste({ id: 2, type: 'image', content: '' })).toBe(false)
    expect(isValidImagePaste({ id: 3, type: 'image', content: 'base64' })).toBe(
      true,
    )

    expect(getImagePasteIds(undefined)).toBeUndefined()
    expect(
      getImagePasteIds({
        1: { id: 1, type: 'text', content: 'abc' },
        2: { id: 2, type: 'image', content: '' },
      }),
    ).toBeUndefined()
    expect(
      getImagePasteIds({
        1: { id: 1, type: 'text', content: 'abc' },
        3: { id: 3, type: 'image', content: 'data' },
      }),
    ).toEqual([3])
  })

  test('reconstructed core domain types satisfy compile-time contracts', () => {
    const userMsg: UserMessage = {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: SAMPLE_UUID,
      timestamp: '2026-01-01T00:00:00Z',
      isMeta: true,
      origin: { kind: 'human' },
    }

    const compactMeta: CompactMetadata = {
      trigger: 'auto',
      preTokens: 120_000,
    }
    const boundary: SystemCompactBoundaryMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Compacted',
      level: 'info',
      compactMetadata: compactMeta,
      uuid: SAMPLE_UUID,
      timestamp: '2026-01-01T00:00:01Z',
    }

    const sys: SystemMessage = boundary
    const msg: Message = userMsg
    const tombstone: TombstoneMessage = { type: 'tombstone', message: msg }
    const reqStart: RequestStartEvent = { type: 'stream_request_start' }
    const summary: ToolUseSummaryMessage = {
      type: 'tool_use_summary',
      summary: 'Read 2 files',
      precedingToolUseIds: ['toolu_1'],
      uuid: SAMPLE_UUID,
      timestamp: '2026-01-01T00:00:02Z',
    }

    const normalizedUser: NormalizedUserMessage = {
      ...userMsg,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }
    const collapsed: CollapsedReadSearchGroup = {
      type: 'collapsed_read_search',
      searchCount: 1,
      readCount: 2,
      listCount: 0,
      replCount: 0,
      memorySearchCount: 0,
      memoryReadCount: 0,
      memoryWriteCount: 0,
      readFilePaths: ['a.ts'],
      searchArgs: ['foo'],
      latestDisplayHint: undefined,
      messages: [normalizedUser],
      displayMessage: normalizedUser,
      uuid: SAMPLE_UUID,
      timestamp: '2026-01-01T00:00:03Z',
    }
    const renderable: RenderableMessage = collapsed

    const bashProg: BashProgress = {
      type: 'bash_progress',
      output: 'ok',
      fullOutput: 'ok',
      elapsedTimeSeconds: 1,
      totalLines: 1,
    }
    const shellProg: ShellProgress = bashProg
    const mcpProg: McpProgress = {
      type: 'mcp_progress',
      status: 'progress',
      serverName: 'gh',
      toolName: 'list_prs',
      progress: 1,
      total: 2,
    }
    const agentProg: AgentToolProgress = {
      type: 'agent_progress',
      message: normalizedUser,
      prompt: 'explore',
      agentId: asAgentId('a0123456789abcdef'),
    }
    const toolProg: ToolProgressData = shellProg

    const queueOp: QueueOperationMessage = {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: SAMPLE_UUID,
      content: 'next task',
    }
    const entry: Entry = queueOp

    const nbOutput: NotebookCellOutput = {
      output_type: 'execute_result',
      data: { 'text/plain': ['42'] },
    }
    const nbCell: NotebookCell = {
      cell_type: 'code',
      source: 'print(42)',
      metadata: {},
      outputs: [nbOutput],
    }
    const nb: NotebookContent = {
      cells: [nbCell],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    }

    const statusLine: StatusLineCommandInput = {
      session_id: SAMPLE_UUID,
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
      workspace: { current_dir: '/repo', project_dir: '/repo', added_dirs: [] },
      version: '0.1.0',
      output_style: { name: 'default' },
      cost: {
        total_cost_usd: 0,
        total_duration_ms: 100,
        total_api_duration_ms: 50,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      context_window: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        context_window_size: 200_000,
        current_usage: null,
        used_percentage: null,
        remaining_percentage: null,
      },
      exceeds_200k_tokens: false,
    }
    const fileSug: FileSuggestionCommandInput = {
      session_id: SAMPLE_UUID,
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      query: 'src/',
    }

    const sources: QuerySource[] = [
      'repl_main_thread',
      'repl_main_thread:outputStyle:Explanatory',
      'agent:builtin:Explore',
      'compact',
    ]
    const cont: Continue = { reason: 'next_turn' }
    const term: Terminal = { reason: 'max_turns', turnCount: 10 }

    const nonEditable = [
      'task-notification',
    ] satisfies Permutations<Exclude<PromptInputMode, EditablePromptInputMode>>
    const immutableSample: DeepImmutable<{
      items: string[]
      map: Map<string, number>
    }> = {
      items: ['a'],
      map: new Map([['k', 1]]),
    }

    expect(sys.subtype).toBe('compact_boundary')
    expect(tombstone.type).toBe('tombstone')
    expect(reqStart.type).toBe('stream_request_start')
    expect(summary.precedingToolUseIds).toEqual(['toolu_1'])
    expect(renderable.type).toBe('collapsed_read_search')
    expect(toolProg.type).toBe('bash_progress')
    expect(mcpProg.status).toBe('progress')
    expect(agentProg.type).toBe('agent_progress')
    expect(entry.type).toBe('queue-operation')
    expect(nb.cells[0]?.cell_type).toBe('code')
    expect(statusLine.exceeds_200k_tokens).toBe(false)
    expect(fileSug.query).toBe('src/')
    expect(sources.length).toBe(4)
    expect(cont.reason).toBe('next_turn')
    expect(term.turnCount).toBe(10)
    expect(nonEditable).toEqual(['task-notification'])
    expect(immutableSample.map.get('k')).toBe(1)

    type TupleLengthCheck = NormalizedAssistantMessage['message']['content']['length']
    const tupleLen: TupleLengthCheck = 1
    expect(tupleLen).toBe(1)
    type AssistantApiErrorCheck = AssistantMessage['apiError']
    const apiErr: AssistantApiErrorCheck = 'max_output_tokens'
    expect(apiErr).toBe('max_output_tokens')
  })

  test('Zod v4 bidirectional schema parsing for core Phase 0 contracts', () => {
    const queueOpSchema = lazySchema(() =>
      z.object({
        type: z.literal('queue-operation'),
        operation: z.enum(['enqueue', 'dequeue', 'remove', 'popAll']),
        timestamp: z.string(),
        sessionId: z.string(),
        content: z.string().optional(),
      }),
    )

    const permissionRuleSchema = lazySchema(() =>
      z.object({
        source: z.enum([
          'userSettings',
          'projectSettings',
          'localSettings',
          'flagSettings',
          'policySettings',
          'cliArg',
          'command',
          'session',
        ]),
        ruleBehavior: z.enum(['allow', 'deny', 'ask']),
        ruleValue: z.object({
          toolName: z.string(),
          ruleContent: z.string().optional(),
        }),
      }),
    )

    const coercedToolInputSchema = lazySchema(() =>
      z.object({
        mode: z.enum(EXTERNAL_PERMISSION_MODES),
        replaceAll: semanticBoolean(z.boolean().default(false)),
        limit: semanticNumber(z.number().int().positive().optional()),
      }),
    )

    const parsedQueue: QueueOperationMessage = queueOpSchema().parse({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: SAMPLE_UUID,
      content: 'hello',
    })
    expect(parsedQueue.operation).toBe('enqueue')

    const parsedRule: PermissionRule = permissionRuleSchema().parse({
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: 'git status' },
    })
    expect(parsedRule.ruleValue.toolName).toBe('Bash')

    const parsedInput = coercedToolInputSchema().parse({
      mode: 'plan',
      replaceAll: 'true',
      limit: '25',
    })
    expect(parsedInput).toEqual({ mode: 'plan', replaceAll: true, limit: 25 })
    expect(() =>
      coercedToolInputSchema().parse({ mode: 'invalid-mode' }),
    ).toThrow()
  })
})
