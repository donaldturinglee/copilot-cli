import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import { runHeadless } from '../../src/cli/print.js'
import type { QueryDeps } from '../../src/query/deps.js'
import type { QueryModelParams } from '../../src/services/api/claude.js'
import { queryModelWithStreaming } from '../../src/services/api/claude.js'
import { asAnyTool } from '../../src/tool.js'
import { NotebookEditTool } from '../../src/tools/notebook_edit_tool/notebook_edit_tool.js'
import { ToolSearchTool } from '../../src/tools/tool_search_tool/tool_search_tool.js'
import { randomUUID } from '../../src/utilities/crypto.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utilities/messages.js'
import type { SdkResultMessage } from '../../src/utilities/messages/mappers.js'
import { asSystemPrompt } from '../../src/utilities/system_prompt_type.js'

function makeAssistantToolCall(blocks: BetaToolUseBlock[]) {
  const msg = createAssistantMessage({ content: blocks })
  msg.message.stop_reason = 'tool_use'
  return msg
}

function makeAssistantFinal(text: string) {
  const msg = createAssistantMessage({ content: text })
  msg.message.stop_reason = 'end_turn'
  return msg
}

describe('Phase 3 Integration: Headless -p coding loop, ToolSearch deferred discovery, and --json-schema StructuredOutput', () => {
  let tempDir: string
  let prevCwd: string
  const origEnableToolSearch = process.env.ENABLE_TOOL_SEARCH
  const origConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    prevCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-p3-int-'))
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, '.copilot-home')
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    setOriginalCwd(tempDir)
    setCwdState(tempDir)
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
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('Headless -p loop executes parallel Read + Grep -> Edit -> final summary using StreamingToolExecutor', async () => {
    const fileA = join(tempDir, 'a.txt')
    const fileB = join(tempDir, 'b.txt')
    writeFileSync(fileA, 'alpha=1\n', 'utf8')
    writeFileSync(fileB, 'beta=2\n', 'utf8')

    let turn = 0
    const capturedToolResults: string[] = []

    const mockDeps: QueryDeps = {
      uuid: () => randomUUID(),
      microcompact: async msgs => ({ messages: msgs }),
      autocompact: async () => ({ wasCompacted: false }),
      callModel: async function* (params: QueryModelParams) {
        turn++
        if (turn === 1) {
          yield makeAssistantToolCall([
            {
              type: 'tool_use',
              id: 'tu_read_a',
              name: 'Read',
              input: { file_path: fileA },
            },
            {
              type: 'tool_use',
              id: 'tu_read_b',
              name: 'Read',
              input: { file_path: fileB },
            },
            {
              type: 'tool_use',
              id: 'tu_grep',
              name: 'Grep',
              input: { pattern: 'alpha', path: tempDir },
            },
          ])
          return
        }
        if (turn === 2) {
          // Verify Read + Grep results arrived before Edit
          for (const m of params.messages) {
            if (m.type === 'user' && Array.isArray(m.message.content)) {
              for (const b of m.message.content) {
                if (b.type === 'tool_result') {
                  capturedToolResults.push(`${b.tool_use_id}:${String(b.content)}`)
                }
              }
            }
          }
          yield makeAssistantToolCall([
            {
              type: 'tool_use',
              id: 'tu_edit_a',
              name: 'Edit',
              input: {
                file_path: fileA,
                old_string: 'alpha=1',
                new_string: 'alpha=99',
              },
            },
          ])
          return
        }
        yield makeAssistantFinal('Updated alpha to 99.')
      },
    }

    let stdout = ''
    const run = await runHeadless('Update alpha to 99', {
      outputFormat: 'json',
      dangerouslySkipPermissions: true,
      skipExit: true,
      deps: mockDeps,
      stdoutWriter: chunk => {
        stdout += chunk
      },
      stderrWriter: () => {},
    })

    expect(run.exitCode).toBe(0)
    expect(readFileSync(fileA, 'utf8')).toBe('alpha=99\n')
    expect(capturedToolResults.some(s => s.startsWith('tu_read_a:') && s.includes('alpha=1'))).toBe(true)
    expect(capturedToolResults.some(s => s.startsWith('tu_read_b:') && s.includes('beta=2'))).toBe(true)
    expect(capturedToolResults.some(s => s.startsWith('tu_grep:') && s.includes('a.txt'))).toBe(true)
    const parsed = JSON.parse(stdout) as SdkResultMessage
    expect(parsed.subtype).toBe('success')
  })

  test('ToolSearch deferred tool discovery clears defer_loading on API payload and allows invocation', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const sentPayloads: Array<{ tools?: Array<{ name: string; defer_loading?: boolean }> }> = []

    const fakeClient = {
      beta: {
        messages: {
          create: (params: Record<string, unknown>) => {
            sentPayloads.push(
              params as { tools?: Array<{ name: string; defer_loading?: boolean }> },
            )
            return {
              withResponse: async () => ({
                data: (async function* () {
                  yield {
                    type: 'message_start',
                    message: {
                      id: 'msg_1',
                      type: 'message',
                      role: 'assistant',
                      model: 'claude-sonnet-4-6',
                      content: [],
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: 10, output_tokens: 5 },
                    },
                  }
                  yield {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                  }
                  yield {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: 'ok' },
                  }
                  yield { type: 'content_block_stop', index: 0 }
                  yield {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { output_tokens: 5 },
                  }
                  yield { type: 'message_stop' }
                })(),
                response: new Response(null, { status: 200 }),
                request_id: 'req_1',
              }),
            }
          },
        },
      },
    }

    const tools = [asAnyTool(ToolSearchTool), asAnyTool(NotebookEditTool)]

    // Turn 1: NotebookEdit is NOT yet discovered -> defer_loading: true
    for await (const _ of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'edit notebook' })],
      systemPrompt: asSystemPrompt(['sys']),
      thinkingConfig: { type: 'disabled' },
      tools,
      signal: new AbortController().signal,
      options: {
        model: 'claude-sonnet-4-6',
        enablePromptCaching: false,
        clientFactoryOverride: async () => fakeClient as never,
      },
    })) {
      // drain
    }

    const turn1Nb = sentPayloads[0]?.tools?.find(t => t.name === 'NotebookEdit')
    expect(turn1Nb?.defer_loading).toBe(true)

    // Turn 2: ToolSearch returned tool_reference for NotebookEdit -> defer_loading omitted!
    const tsBlock = ToolSearchTool.mapToolResultToToolResultBlockParam(
      { matches: ['NotebookEdit'], query: 'select:NotebookEdit', total_deferred_tools: 1 },
      'ts_1',
    )
    for await (const _ of queryModelWithStreaming({
      messages: [
        createUserMessage({ content: 'edit notebook' }),
        makeAssistantToolCall([
          {
            type: 'tool_use',
            id: 'ts_1',
            name: 'ToolSearch',
            input: { query: 'select:NotebookEdit' },
          },
        ]),
        createUserMessage({ content: [tsBlock] }),
      ],
      systemPrompt: asSystemPrompt(['sys']),
      thinkingConfig: { type: 'disabled' },
      tools,
      signal: new AbortController().signal,
      options: {
        model: 'claude-sonnet-4-6',
        enablePromptCaching: false,
        clientFactoryOverride: async () => fakeClient as never,
      },
    })) {
      // drain
    }

    const turn2Nb = sentPayloads[1]?.tools?.find(t => t.name === 'NotebookEdit')
    expect(turn2Nb?.defer_loading).toBeUndefined()
  })

  test('--json-schema enforces StructuredOutput validation with self-correction retry and surfaces structured_output in -p json mode', async () => {
    let callNum = 0
    let sawValidationError = false

    const mockDeps: QueryDeps = {
      uuid: () => randomUUID(),
      microcompact: async msgs => ({ messages: msgs }),
      autocompact: async () => ({ wasCompacted: false }),
      callModel: async function* (params: QueryModelParams) {
        callNum++
        if (callNum === 1) {
          // Invalid schema payload first (missing required `status` and wrong type for `count`)
          yield makeAssistantToolCall([
            {
              type: 'tool_use',
              id: 'so_bad',
              name: 'StructuredOutput',
              input: { count: 'not-a-number' },
            },
          ])
          return
        }
        if (callNum === 2) {
          for (const m of params.messages) {
            if (m.type === 'user' && Array.isArray(m.message.content)) {
              for (const b of m.message.content) {
                if (
                  b.type === 'tool_result' &&
                  b.tool_use_id === 'so_bad' &&
                  b.is_error === true
                ) {
                  sawValidationError = true
                }
              }
            }
          }
          // Self-corrected valid payload
          yield makeAssistantToolCall([
            {
              type: 'tool_use',
              id: 'so_good',
              name: 'StructuredOutput',
              input: { status: 'ok', count: 3 },
            },
          ])
          return
        }
        yield makeAssistantFinal('Done')
      },
    }

    let stdout = ''
    const run = await runHeadless('Return structured JSON', {
      outputFormat: 'json',
      jsonSchema: JSON.stringify({
        type: 'object',
        properties: {
          status: { type: 'string' },
          count: { type: 'integer' },
        },
        required: ['status', 'count'],
        additionalProperties: false,
      }),
      skipExit: true,
      deps: mockDeps,
      stdoutWriter: chunk => {
        stdout += chunk
      },
      stderrWriter: () => {},
    })

    expect(run.exitCode).toBe(0)
    expect(sawValidationError).toBe(true)
    const parsed = JSON.parse(stdout) as SdkResultMessage
    expect(parsed.subtype).toBe('success')
    if (parsed.subtype === 'success') {
      expect(parsed.structured_output).toEqual({ status: 'ok', count: 3 })
    }
  })

  test('--json-schema emits error_max_structured_output_retries when model never calls StructuredOutput', async () => {
    const mockDeps: QueryDeps = {
      uuid: () => randomUUID(),
      microcompact: async msgs => ({ messages: msgs }),
      autocompact: async () => ({ wasCompacted: false }),
      callModel: async function* () {
        yield makeAssistantFinal('Just plain text without calling StructuredOutput')
      },
    }

    let stdout = ''
    const run = await runHeadless('Return JSON', {
      outputFormat: 'json',
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      skipExit: true,
      deps: mockDeps,
      stdoutWriter: chunk => {
        stdout += chunk
      },
      stderrWriter: () => {},
    })

    expect(run.exitCode).toBe(1)
    const parsed = JSON.parse(stdout) as SdkResultMessage
    expect(parsed.subtype).toBe('error_max_structured_output_retries')
    expect(parsed.is_error).toBe(true)
  })
})
