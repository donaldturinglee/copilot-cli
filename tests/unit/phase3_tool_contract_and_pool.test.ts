import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  asAnyTool,
  buildTool,
  findToolByName,
  toolMatchesName,
} from '../../src/tool.js'
import {
  assembleToolPool,
  filterToolsByDenyRules,
  getTools,
  parseToolPreset,
} from '../../src/tools.js'
import { getEmptyToolPermissionContext } from '../../src/types/permissions.js'
import { clearToolSchemaCache, toolToApiSchema } from '../../src/utilities/api.js'
import { formatZodValidationError } from '../../src/utilities/tool_errors.js'

function makeDummyTool(
  name: string,
  extra?: {
    aliases?: string[]
    isMcp?: boolean
    isEnabled?: () => boolean
    shouldDefer?: boolean
  },
) {
  return asAnyTool(
    buildTool({
      name,
      aliases: extra?.aliases,
      isMcp: extra?.isMcp,
      isEnabled: extra?.isEnabled,
      shouldDefer: extra?.shouldDefer,
      maxResultSizeChars: 50_000,
      inputSchema: z.object({ value: z.string() }),
      async description() {
        return `Description for ${name}`
      },
      async prompt() {
        return `Prompt for ${name}`
      },
      async call(input) {
        return { data: input.value }
      },
      mapToolResultToToolResultBlockParam(content, toolUseId) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
        }
      },
    }),
  )
}

describe('Phase 3.1: Tool contract, buildTool() defaults, and pool assembly', () => {
  const origSimple = process.env.COPILOT_CLI_SIMPLE

  afterEach(() => {
    if (origSimple === undefined) {
      delete process.env.COPILOT_CLI_SIMPLE
    } else {
      process.env.COPILOT_CLI_SIMPLE = origSimple
    }
    clearToolSchemaCache()
  })

  test('buildTool() applies fail-closed security defaults', async () => {
    const tool = buildTool({
      name: 'SampleMutator',
      maxResultSizeChars: 10_000,
      inputSchema: z.object({ path: z.string() }),
      async description() {
        return 'desc'
      },
      async prompt() {
        return 'prompt'
      },
      async call() {
        return { data: 'ok' }
      },
      mapToolResultToToolResultBlockParam(content, toolUseId) {
        return { type: 'tool_result', tool_use_id: toolUseId, content }
      },
    })

    expect(tool.isEnabled()).toBe(true)
    expect(tool.isReadOnly({ path: '/tmp/a' })).toBe(false)
    expect(tool.isConcurrencySafe({ path: '/tmp/a' })).toBe(false)
    expect(tool.isDestructive({ path: '/tmp/a' })).toBe(false)
    expect(tool.interruptBehavior()).toBe('block')
    expect(tool.toAutoClassifierInput({ path: '/tmp/a' })).toBe('')
    expect(tool.userFacingName()).toBe('SampleMutator')
    const perm = await tool.checkPermissions(
      { path: '/tmp/a' },
      { abortController: new AbortController(), messages: [] },
    )
    expect(perm.behavior).toBe('allow')
  })

  test('toolMatchesName() and findToolByName() resolve aliases', () => {
    const t1 = makeDummyTool('Read', { aliases: ['FileRead'] })
    const t2 = makeDummyTool('SendUserMessage', { aliases: ['Brief'] })

    expect(toolMatchesName(t1, 'Read')).toBe(true)
    expect(toolMatchesName(t1, 'FileRead')).toBe(true)
    expect(toolMatchesName(t1, 'Write')).toBe(false)
    expect(findToolByName([t1, t2], 'Brief')?.name).toBe('SendUserMessage')
    expect(findToolByName([t1, t2], 'Unknown')).toBeUndefined()
  })

  test('assembleToolPool() sorts built-in and MCP tools in separate partitions and built-ins win collisions', () => {
    const permCtx = getEmptyToolPermissionContext()
    const baseTools = [
      makeDummyTool('Zeta'),
      makeDummyTool('Alpha'),
      makeDummyTool('Middle'),
    ]
    const mcpSet1 = [
      makeDummyTool('mcp__srv__b', { isMcp: true }),
      makeDummyTool('Alpha', { isMcp: true }), // collision with built-in
      makeDummyTool('mcp__srv__a', { isMcp: true }),
    ]
    const mcpSet2 = [
      makeDummyTool('mcp__aaa__first', { isMcp: true }),
      ...mcpSet1,
    ]

    const pool1 = assembleToolPool(permCtx, mcpSet1, { baseTools })
    const pool2 = assembleToolPool(permCtx, mcpSet2, { baseTools })

    expect(pool1.map(t => t.name)).toEqual([
      'Alpha',
      'Middle',
      'Zeta',
      'mcp__srv__a',
      'mcp__srv__b',
    ])
    // Adding mcp__aaa__first MUST NOT shift built-in prefix [Alpha, Middle, Zeta]
    expect(pool2.slice(0, 3).map(t => t.name)).toEqual([
      'Alpha',
      'Middle',
      'Zeta',
    ])
    expect(pool2.slice(3).map(t => t.name)).toEqual([
      'mcp__aaa__first',
      'mcp__srv__a',
      'mcp__srv__b',
    ])
    // Built-in Alpha won over colliding MCP Alpha
    expect(pool1[0]!.isMcp).not.toBe(true)
  })

  test('COPILOT_CLI_SIMPLE restricts built-in tools to Bash, Read, and Edit', () => {
    process.env.COPILOT_CLI_SIMPLE = '1'
    const permCtx = getEmptyToolPermissionContext()
    const tools = getTools(permCtx)
    expect(tools.map(t => t.name).sort()).toEqual(['Bash', 'Edit', 'Read'])
  })

  test('filterToolsByDenyRules() removes blanket-denied tools and MCP server prefixes', () => {
    const permCtx = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: {
        userSettings: ['Bash', 'mcp__blocked', 'Read(secret.txt)'],
      },
    }
    const candidates = [
      makeDummyTool('Bash'),
      makeDummyTool('Read'),
      makeDummyTool('mcp__blocked__run', { isMcp: true }),
      makeDummyTool('mcp__allowed__run', { isMcp: true }),
    ]

    const filtered = filterToolsByDenyRules(candidates, permCtx)
    // Content-scoped Read(secret.txt) must NOT remove Read from the tool pool
    expect(filtered.map(t => t.name)).toEqual(['Read', 'mcp__allowed__run'])
  })

  test('parseToolPreset(), toolToApiSchema(), and formatZodValidationError() work cleanly', async () => {
    expect(parseToolPreset('default')).toBe('default')
    expect(parseToolPreset('Read')).toBeNull()

    const tool = makeDummyTool('DemoTool')
    const schema = await toolToApiSchema(tool, { deferLoading: true })
    expect(schema.name).toBe('DemoTool')
    expect(schema.description).toBe('Prompt for DemoTool')
    expect(schema.defer_loading).toBe(true)
    expect(schema.input_schema.type).toBe('object')
    expect(
      (schema.input_schema.properties as Record<string, unknown>).value,
    ).toBeDefined()

    const bad = tool.inputSchema.safeParse({ value: 123 })
    expect(bad.success).toBe(false)
    if (!bad.success) {
      const formatted = formatZodValidationError('DemoTool', bad.error)
      expect(formatted).toContain('DemoTool')
      expect(formatted).toContain('value')
    }
  })
})
