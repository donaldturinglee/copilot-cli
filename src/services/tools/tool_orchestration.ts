/**
 * Batch tool call orchestration (`partitionToolCalls`, `runTools`,
 * `runToolsConcurrently`, `runToolsSerially`):
 * - Partitions contiguous concurrency-safe (`isConcurrencySafe()`) tool calls
 *   into parallel batches (default concurrency 10 via
 *   `COPILOT_CLI_MAX_TOOL_USE_CONCURRENCY`) and exclusive/mutating calls into
 *   serial singletons.
 * - Replays `contextModifier` functions deterministically in original
 *   `tool_use` order after concurrent batches complete.
 */

import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ToolRunUpdate } from '../../query/deps.js'
import { findToolByName, type ToolUseContext } from '../../tool.js'
import type { CanUseToolFn } from '../../types/forward.js'
import type { AssistantMessage } from '../../types/message.js'
import { validateBoundedIntEnvVar } from '../../utilities/env_validation.js'
import { all } from '../../utilities/generators.js'
import { runToolUse, type ToolExecutionOutcome } from './tool_execution.js'

export const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10

export interface ToolCallBatch {
  isConcurrencySafe: boolean
  blocks: BetaToolUseBlock[]
}

/**
 * Returns the maximum number of concurrent read-only tool calls (default 10).
 */
export function getMaxToolUseConcurrency(): number {
  return validateBoundedIntEnvVar(
    'COPILOT_CLI_MAX_TOOL_USE_CONCURRENCY',
    process.env.COPILOT_CLI_MAX_TOOL_USE_CONCURRENCY,
    DEFAULT_MAX_TOOL_USE_CONCURRENCY,
    64,
  ).effective
}

/**
 * Safely determines whether a `tool_use` block can run concurrently (fail-closed
 * to `false` for unknown tools, invalid inputs, or exceptions).
 */
export function isToolUseConcurrencySafe(
  block: BetaToolUseBlock,
  toolUseContext: ToolUseContext,
): boolean {
  const tools = toolUseContext.options?.tools ?? []
  const tool = findToolByName(tools, block.name)
  if (!tool) {
    return false
  }
  const parsed = tool.inputSchema.safeParse(block.input ?? {})
  if (!parsed.success) {
    return false
  }
  try {
    return Boolean(tool.isConcurrencySafe(parsed.data as Record<string, unknown>))
  } catch {
    return false
  }
}

/**
 * Partitions an ordered list of `tool_use` blocks into contiguous concurrent
 * batches and exclusive serial singletons.
 */
export function partitionToolCalls(
  toolUseBlocks: readonly BetaToolUseBlock[],
  toolUseContext: ToolUseContext,
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = []

  for (const block of toolUseBlocks) {
    const safe = isToolUseConcurrencySafe(block, toolUseContext)
    const prev = batches[batches.length - 1]
    if (safe && prev?.isConcurrencySafe) {
      prev.blocks.push(block)
    } else {
      batches.push({
        isConcurrencySafe: safe,
        blocks: [block],
      })
    }
  }

  return batches
}

function findAssistantMessageForToolUse(
  toolUseId: string,
  assistantMessages: readonly AssistantMessage[],
): AssistantMessage {
  for (const msg of assistantMessages) {
    if (
      msg.message.content.some(
        b => b.type === 'tool_use' && b.id === toolUseId,
      )
    ) {
      return msg
    }
  }
  return assistantMessages[assistantMessages.length - 1]!
}

/**
 * Executes a concurrent batch of read-only tool calls up to the concurrency
 * cap, forwarding progress/messages as they arrive and replaying any
 * `contextModifier` updates deterministically in original `tool_use` order.
 */
export async function* runToolsConcurrently(
  blocks: readonly BetaToolUseBlock[],
  assistantMessages: readonly AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<ToolRunUpdate, ToolUseContext> {
  const modifiersByIndex = new Map<
    number,
    Array<(ctx: ToolUseContext) => ToolUseContext>
  >()

  type IndexedOutcome = {
    index: number
    outcome: ToolExecutionOutcome
  }

  const generators = blocks.map((block, index) => {
    const parentMsg = findAssistantMessageForToolUse(block.id, assistantMessages)
    return (async function* (): AsyncGenerator<IndexedOutcome, void> {
      for await (const outcome of runToolUse(
        block,
        parentMsg,
        canUseTool,
        toolUseContext,
      )) {
        yield { index, outcome }
      }
    })()
  })

  // Buffer non-progress messages per index so final tool_results commit in original order
  const bufferedFinalByIndex = new Map<number, ToolExecutionOutcome[]>()

  for await (const { index, outcome } of all(
    generators,
    getMaxToolUseConcurrency(),
  )) {
    if (outcome.contextModifier) {
      const list = modifiersByIndex.get(index) ?? []
      list.push(outcome.contextModifier)
      modifiersByIndex.set(index, list)
    }
    if (outcome.message?.type === 'progress') {
      yield { message: outcome.message }
    } else if (outcome.message) {
      const list = bufferedFinalByIndex.get(index) ?? []
      list.push(outcome)
      bufferedFinalByIndex.set(index, list)
    }
  }

  // Emit buffered tool_results & attachments strictly in original tool_use order
  for (let i = 0; i < blocks.length; i++) {
    const items = bufferedFinalByIndex.get(i)
    if (!items) continue
    for (const item of items) {
      if (item.message) {
        yield { message: item.message }
      }
    }
  }

  // Deterministically replay contextModifiers in original tool_use index order
  let currentContext = toolUseContext
  let modified = false
  for (let i = 0; i < blocks.length; i++) {
    const mods = modifiersByIndex.get(i)
    if (!mods) continue
    for (const mod of mods) {
      currentContext = mod(currentContext)
      modified = true
    }
  }

  if (modified) {
    yield { newContext: currentContext }
  }

  return currentContext
}

/**
 * Executes tool calls strictly one-by-one, threading `contextModifier` updates
 * immediately into subsequent tool executions.
 */
export async function* runToolsSerially(
  blocks: readonly BetaToolUseBlock[],
  assistantMessages: readonly AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<ToolRunUpdate, ToolUseContext> {
  let currentContext = toolUseContext

  for (const block of blocks) {
    const parentMsg = findAssistantMessageForToolUse(block.id, assistantMessages)
    for await (const outcome of runToolUse(
      block,
      parentMsg,
      canUseTool,
      currentContext,
    )) {
      if (outcome.contextModifier) {
        currentContext = outcome.contextModifier(currentContext)
        yield { newContext: currentContext }
      }
      if (outcome.message) {
        yield { message: outcome.message }
      }
    }
  }

  return currentContext
}

/**
 * Orchestrates a turn's `tool_use` blocks by partitioning contiguous read-only
 * calls into parallel batches and mutating calls into serial steps.
 */
export async function* runTools(
  toolUseBlocks: BetaToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<ToolRunUpdate, void> {
  const batches = partitionToolCalls(toolUseBlocks, toolUseContext)
  let currentContext = toolUseContext

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.blocks.length > 1) {
      currentContext = yield* runToolsConcurrently(
        batch.blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )
    } else {
      currentContext = yield* runToolsSerially(
        batch.blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )
    }
  }
}
