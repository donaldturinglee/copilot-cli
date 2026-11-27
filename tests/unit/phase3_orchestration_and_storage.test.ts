import { describe, expect, test } from 'bun:test'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { readFileSync } from 'fs'
import { z } from 'zod/v4'
import { StreamingToolExecutor } from '../../src/services/tools/streaming_tool_executor.js'
import {
  partitionToolCalls,
  runTools,
} from '../../src/services/tools/tool_orchestration.js'
import {
  asAnyTool,
  buildTool,
  type ToolUseContext,
} from '../../src/tool.js'
import type { CanUseToolFn } from '../../src/types/forward.js'
import type { AssistantMessage, Message, UserMessage } from '../../src/types/message.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utilities/messages.js'
import {
  createContentReplacementState,
  enforceToolResultBudget,
  PERSISTED_OUTPUT_TAG,
  processPreMappedToolResultBlock,
  reconstructContentReplacementState,
} from '../../src/utilities/tool_result_storage.js'

const allowAll: CanUseToolFn = async (_tool, input) => ({
  behavior: 'allow',
  updatedInput: input,
})

function makeToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): BetaToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input,
  }
}

function makeAssistantWithTools(blocks: BetaToolUseBlock[]): AssistantMessage {
  return createAssistantMessage({ content: blocks })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('Phase 3.5: Tool orchestration, StreamingToolExecutor, and toolResultStorage', () => {
  test('partitionToolCalls() groups contiguous concurrent tools and isolates exclusive tools', () => {
    const readTool = asAnyTool(
      buildTool({
        name: 'Read',
        maxResultSizeChars: Infinity,
        inputSchema: z.object({ id: z.string() }),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async description() { return 'read' },
        async prompt() { return 'read' },
        async call(i) { return { data: i.id } },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: c,
        }),
      }),
    )
    const editTool = asAnyTool(
      buildTool({
        name: 'Edit',
        maxResultSizeChars: 50_000,
        inputSchema: z.object({ id: z.string() }),
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        async description() { return 'edit' },
        async prompt() { return 'edit' },
        async call(i) { return { data: i.id } },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: c,
        }),
      }),
    )

    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      options: { tools: [readTool, editTool] },
    }

    const batches = partitionToolCalls(
      [
        makeToolUse('u1', 'Read', { id: '1' }),
        makeToolUse('u2', 'Read', { id: '2' }),
        makeToolUse('u3', 'Edit', { id: '3' }),
        makeToolUse('u4', 'Read', { id: '4' }),
      ],
      ctx,
    )

    expect(batches.length).toBe(3)
    expect(batches[0]!.isConcurrencySafe).toBe(true)
    expect(batches[0]!.blocks.map(b => b.id)).toEqual(['u1', 'u2'])
    expect(batches[1]!.isConcurrencySafe).toBe(false)
    expect(batches[1]!.blocks.map(b => b.id)).toEqual(['u3'])
    expect(batches[2]!.isConcurrencySafe).toBe(true)
    expect(batches[2]!.blocks.map(b => b.id)).toEqual(['u4'])
  })

  test('runTools() runs concurrent Read batch in parallel, replays contextModifiers deterministically, and does not mutate original input', async () => {
    const events: string[] = []
    const readTool = asAnyTool(
      buildTool({
        name: 'Read',
        maxResultSizeChars: Infinity,
        inputSchema: z.object({ key: z.string(), waitMs: z.number() }),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        backfillObservableInput(input) {
          input.key = `expanded:${String(input.key)}`
        },
        async description() { return 'read' },
        async prompt() { return 'read' },
        async call(i) {
          events.push(`start:${i.key}`)
          await delay(i.waitMs)
          events.push(`end:${i.key}`)
          return {
            data: i.key,
            contextModifier: prev => ({
              ...prev,
              trace: [...((prev.trace as string[] | undefined) ?? []), i.key],
            }),
          }
        },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: c,
        }),
      }),
    )

    const blocks = [
      makeToolUse('r1', 'Read', { key: 'first', waitMs: 60 }),
      makeToolUse('r2', 'Read', { key: 'second', waitMs: 10 }),
    ]
    const assistant = makeAssistantWithTools(blocks)
    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      options: { tools: [readTool] },
    }

    const resultIds: string[] = []
    let finalCtx: ToolUseContext = ctx
    for await (const upd of runTools(blocks, [assistant], allowAll, ctx)) {
      if (upd.message?.type === 'user' && Array.isArray(upd.message.message.content)) {
        const firstBlock = upd.message.message.content[0]
        if (firstBlock?.type === 'tool_result') {
          resultIds.push(firstBlock.tool_use_id)
        }
      }
      if (upd.newContext) {
        finalCtx = upd.newContext
      }
    }

    // Second finished before first ended -> proves true concurrent execution
    expect(events.indexOf('start:expanded:second')).toBeLessThan(
      events.indexOf('end:expanded:first'),
    )
    // Results and contextModifiers commit strictly in original tool_use order [r1, r2]
    expect(resultIds).toEqual(['r1', 'r2'])
    expect(finalCtx.trace).toEqual(['expanded:first', 'expanded:second'])
    // Original assistantMessage tool_use input was NEVER mutated (Prompt Cache invariant!)
    expect((blocks[0]!.input as Record<string, unknown>).key).toBe('first')
  })

  test('StreamingToolExecutor cascades sibling abort ONLY on Bash errors, preserves arrival order, and respects interruptBehavior', async () => {
    let readSiblingAborted = false
    let blockSiblingAborted = false

    const failingBash = asAnyTool(
      buildTool({
        name: 'Bash',
        maxResultSizeChars: 30_000,
        inputSchema: z.object({ fail: z.boolean() }),
        isConcurrencySafe: () => true,
        interruptBehavior: () => 'cancel',
        async description() { return 'bash' },
        async prompt() { return 'bash' },
        async call() {
          await delay(15)
          throw new Error('boom from bash')
        },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: String(c),
        }),
      }),
    )

    const cancellableRead = asAnyTool(
      buildTool({
        name: 'Read',
        maxResultSizeChars: Infinity,
        inputSchema: z.object({ label: z.string() }),
        isConcurrencySafe: () => true,
        interruptBehavior: () => 'cancel',
        async description() { return 'read' },
        async prompt() { return 'read' },
        async call(_input, context) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 250)
            context.abortController.signal.addEventListener(
              'abort',
              () => {
                readSiblingAborted = true
                clearTimeout(timer)
                resolve()
              },
              { once: true },
            )
          })
          return { data: 'done' }
        },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: c,
        }),
      }),
    )

    const blockingTool = asAnyTool(
      buildTool({
        name: 'BlockingOp',
        maxResultSizeChars: 50_000,
        inputSchema: z.object({}),
        isConcurrencySafe: () => true,
        interruptBehavior: () => 'block',
        async description() { return 'block' },
        async prompt() { return 'block' },
        async call(_input, context) {
          await delay(60)
          blockSiblingAborted = context.abortController.signal.aborted
          return { data: 'survived' }
        },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: c,
        }),
      }),
    )

    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      options: { tools: [failingBash, cancellableRead, blockingTool] },
    }
    const executor = new StreamingToolExecutor(allowAll, ctx)
    const b1 = makeToolUse('t1', 'Read', { label: 'a' })
    const b2 = makeToolUse('t2', 'Bash', { fail: true })
    const b3 = makeToolUse('t3', 'BlockingOp', {})
    const asst = makeAssistantWithTools([b1, b2, b3])

    executor.addTool(b1, asst)
    executor.addTool(b2, asst)
    executor.addTool(b3, asst)

    const orderedIds: string[] = []
    for await (const upd of executor.getRemainingResults()) {
      if (upd.message?.type === 'user' && Array.isArray(upd.message.message.content)) {
        const blk = upd.message.message.content[0]
        if (blk?.type === 'tool_result') orderedIds.push(blk.tool_use_id)
      }
    }

    expect(readSiblingAborted).toBe(true)
    expect(blockSiblingAborted).toBe(false)
    expect(orderedIds).toEqual(['t1', 't2', 't3'])

    // Verify non-Bash tool error does NOT abort sibling tools
    let nonBashSiblingAborted = false
    const failingNonBash = asAnyTool(
      buildTool({
        name: 'Grep',
        maxResultSizeChars: 20_000,
        inputSchema: z.object({}),
        isConcurrencySafe: () => true,
        interruptBehavior: () => 'cancel',
        async description() { return 'grep' },
        async prompt() { return 'grep' },
        async call() {
          await delay(10)
          throw new Error('grep error')
        },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: String(c),
        }),
      }),
    )
    const watcherRead = asAnyTool(
      buildTool({
        name: 'Read',
        maxResultSizeChars: Infinity,
        inputSchema: z.object({}),
        isConcurrencySafe: () => true,
        interruptBehavior: () => 'cancel',
        async description() { return 'read' },
        async prompt() { return 'read' },
        async call(_i, c) {
          await delay(50)
          nonBashSiblingAborted = c.abortController.signal.aborted
          return { data: 'ok' }
        },
        mapToolResultToToolResultBlockParam: (c, id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: c,
        }),
      }),
    )
    const ctx2: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      options: { tools: [failingNonBash, watcherRead] },
    }
    const exec2 = new StreamingToolExecutor(allowAll, ctx2)
    const g1 = makeToolUse('g1', 'Grep', {})
    const r1 = makeToolUse('r1', 'Read', {})
    const asst2 = makeAssistantWithTools([g1, r1])
    exec2.addTool(g1, asst2)
    exec2.addTool(r1, asst2)
    for await (const _ of exec2.getRemainingResults()) {
      // drain
    }
    expect(nonBashSiblingAborted).toBe(false)
  })

  test('toolResultStorage spills >50k outputs to disk with 2KB preview, skips Read (Infinity), and freezes ContentReplacementState', () => {
    const bigPayload = Array.from({ length: 2000 }, (_, i) => `Line ${i}: ${'x'.repeat(30)}`).join('\n')
    expect(bigPayload.length).toBeGreaterThan(50_000)

    // 1. Per-tool 50k threshold spills to disk
    const spilled = processPreMappedToolResultBlock(
      { type: 'tool_result', tool_use_id: 'spill_test_1', content: bigPayload },
      { maxResultSizeChars: 50_000 },
    )
    const text = String(spilled.content)
    expect(text).toContain(PERSISTED_OUTPUT_TAG)
    const pathMatch = text.match(/Full output saved to:\s*(.+)/)
    expect(pathMatch?.[1]).toBeTruthy()
    expect(readFileSync(pathMatch![1]!.trim(), 'utf8')).toBe(bigPayload)

    // 2. Read (Infinity) opts out of spilling
    const readKept = processPreMappedToolResultBlock(
      { type: 'tool_result', tool_use_id: 'read_keep_1', content: bigPayload },
      { maxResultSizeChars: Infinity },
    )
    expect(readKept.content).toBe(bigPayload)

    // 3. Per-message 200k aggregate budget + ContentReplacementState freezing
    const state = createContentReplacementState()
    const chunkA = 'A'.repeat(40_000)
    const chunkB = 'B'.repeat(45_000)
    const chunkC = 'C'.repeat(45_000)
    const asst = makeAssistantWithTools([
      makeToolUse('m1', 'Bash', {}),
      makeToolUse('m2', 'Bash', {}),
      makeToolUse('m3', 'Bash', {}),
    ])
    const msgs: Message[] = [
      asst,
      createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'm1', content: chunkA },
          { type: 'tool_result', tool_use_id: 'm2', content: chunkB },
          { type: 'tool_result', tool_use_id: 'm3', content: chunkC },
        ],
      }),
    ]

    // First pass with 100k per-message budget spills largest result(s) until <= 100k
    const pass1 = enforceToolResultBudget(msgs, state, 100_000)
    expect(pass1.replacedIds.length).toBeGreaterThanOrEqual(1)
    expect(state.seenIds.has('m1')).toBe(true)
    expect(state.seenIds.has('m2')).toBe(true)
    expect(state.seenIds.has('m3')).toBe(true)

    // Second pass with MUCH lower budget (10k) MUST NOT retroactively replace m1 (frozen as kept!)
    const pass2 = enforceToolResultBudget(msgs, state, 10_000)
    expect(pass2.replacedIds).toEqual([])
    const userMsg = pass2.messages[1] as UserMessage
    const blocks = userMsg.message.content as Array<{ tool_use_id: string; content: string }>
    const m1Block = blocks.find(b => b.tool_use_id === 'm1')!
    expect(m1Block.content).toBe(chunkA)

    // Reconstruction preserves exact frozen replacements
    const rebuilt = reconstructContentReplacementState(state.records, state.seenIds)
    expect(rebuilt.replacements.size).toBe(state.replacements.size)
  })
})
