/**
 * `StreamingToolExecutor`:
 * Executes tools mid-stream as `tool_use` content blocks complete:
 * - Parallel execution of concurrency-safe tools (`isConcurrencySafe() === true`)
 *   up to `getMaxToolUseConcurrency()` (default 10); exclusive serial execution
 *   for mutating tools.
 * - Immediate forwarding of `progress` events while preserving strict arrival
 *   order for final `tool_result` messages and deterministic `contextModifier`
 *   replay.
 * - Hierarchical `AbortController`: sibling cancellation (`siblingAbortController`)
 *   is triggered **only** by `Bash`/`PowerShell` errors, respecting each tool's
 *   `interruptBehavior()` (`'cancel'` vs `'block'`).
 * - Clean `discard()` support on streaming fallback / model fallback.
 */

import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { BASH_TOOL_NAME, POWERSHELL_TOOL_NAME } from '../../constants/tools.js'
import type { ToolRunUpdate } from '../../query/deps.js'
import {
  findToolByName,
  type InterruptBehavior,
  type ToolUseContext,
} from '../../tool.js'
import type { CanUseToolFn } from '../../types/forward.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createChildAbortController } from '../../utilities/abort_controller.js'
import { createUserMessage } from '../../utilities/messages.js'
import { runToolUse } from './tool_execution.js'
import {
  getMaxToolUseConcurrency,
  isToolUseConcurrencySafe,
} from './tool_orchestration.js'

const CASCADING_ERROR_TOOL_NAMES = new Set<string>([
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
])

type TrackedStatus = 'queued' | 'executing' | 'completed' | 'yielded'

interface TrackedTool {
  id: string
  index: number
  block: BetaToolUseBlock
  assistantMessage: AssistantMessage
  isConcurrencySafe: boolean
  interruptBehavior: InterruptBehavior
  status: TrackedStatus
  results: Message[]
  contextModifiers: Array<(ctx: ToolUseContext) => ToolUseContext>
  promise?: Promise<void>
}

export class StreamingToolExecutor {
  private readonly tools: TrackedTool[] = []
  private readonly progressQueue: Message[] = []
  private readonly canUseTool: CanUseToolFn
  private toolUseContext: ToolUseContext
  private readonly siblingAbortController: AbortController
  private readonly maxConcurrency: number
  private hasErroredShell = false
  private discarded = false
  private notifyWaiter: (() => void) | null = null

  constructor(
    canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
    maxConcurrency: number = getMaxToolUseConcurrency(),
  ) {
    this.canUseTool = canUseTool
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )
    this.maxConcurrency = maxConcurrency
  }

  /**
   * Registers a newly arrived `tool_use` block mid-stream and kicks off
   * execution immediately if concurrency rules permit.
   */
  addTool(block: BetaToolUseBlock, assistantMessage: AssistantMessage): void {
    if (this.discarded) {
      return
    }
    const toolDef = findToolByName(
      this.toolUseContext.options?.tools ?? [],
      block.name,
    )
    const isConcurrencySafe = isToolUseConcurrencySafe(
      block,
      this.toolUseContext,
    )
    const interruptBehavior: InterruptBehavior =
      toolDef?.interruptBehavior() ?? 'block'

    const tracked: TrackedTool = {
      id: block.id,
      index: this.tools.length,
      block,
      assistantMessage,
      isConcurrencySafe,
      interruptBehavior,
      status: 'queued',
      results: [],
      contextModifiers: [],
    }

    this.tools.push(tracked)
    this.processQueue()
  }

  /**
   * Aborts all in-flight and queued tools (e.g. during streaming fallback or
   * model fallback recovery).
   */
  discard(): void {
    if (this.discarded) return
    this.discarded = true
    if (!this.siblingAbortController.signal.aborted) {
      this.siblingAbortController.abort('discarded')
    }
    this.wake()
  }

  /**
   * Returns the latest `ToolUseContext` reflecting all replayed
   * `contextModifier` updates from yielded tools.
   */
  getUpdatedContext(): ToolUseContext {
    return this.toolUseContext
  }

  hasTools(): boolean {
    return this.tools.length > 0
  }

  private wake(): void {
    const fn = this.notifyWaiter
    this.notifyWaiter = null
    fn?.()
  }

  private waitForActivity(): Promise<void> {
    return new Promise<void>(resolve => {
      this.notifyWaiter = resolve
    })
  }

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter(t => t.status === 'executing')
    if (executing.length === 0) {
      return true
    }
    if (!isConcurrencySafe) {
      return false
    }
    if (executing.length >= this.maxConcurrency) {
      return false
    }
    return executing.every(t => t.isConcurrencySafe)
  }

  private processQueue(): void {
    if (this.discarded) {
      return
    }

    for (const tracked of this.tools) {
      if (tracked.status !== 'queued') continue

      // If an earlier Bash/PowerShell tool errored, cancel queued cancellable siblings
      if (
        this.hasErroredShell &&
        tracked.interruptBehavior === 'cancel'
      ) {
        tracked.status = 'completed'
        tracked.results.push(
          createUserMessage({
            content: [
              {
                type: 'tool_result',
                tool_use_id: tracked.block.id,
                content:
                  '<tool_use_error>Cancelled: sibling Bash command failed.</tool_use_error>',
                is_error: true,
              },
            ],
            toolUseResult: 'Cancelled: sibling Bash command failed.',
            sourceToolAssistantUuid: tracked.assistantMessage.uuid,
          }),
        )
        this.wake()
        continue
      }

      if (!this.canExecuteTool(tracked.isConcurrencySafe)) {
        // Strict FIFO barrier: do not jump a later tool over an earlier exclusive tool
        break
      }

      tracked.status = 'executing'
      tracked.promise = this.executeTrackedTool(tracked)
    }
  }

  private async executeTrackedTool(tracked: TrackedTool): Promise<void> {
    // Only tools with interruptBehavior === 'cancel' subscribe to sibling abort
    const toolAbortController =
      tracked.interruptBehavior === 'cancel'
        ? this.siblingAbortController
        : this.toolUseContext.abortController

    const perToolContext: ToolUseContext = {
      ...this.toolUseContext,
      abortController: toolAbortController,
    }

    let toolHadError = false
    try {
      for await (const outcome of runToolUse(
        tracked.block,
        tracked.assistantMessage,
        this.canUseTool,
        perToolContext,
      )) {
        if (this.discarded) {
          return
        }
        if (outcome.isError) {
          toolHadError = true
        }
        if (outcome.contextModifier) {
          tracked.contextModifiers.push(outcome.contextModifier)
        }
        if (outcome.message) {
          if (outcome.message.type === 'progress') {
            this.progressQueue.push(outcome.message)
            this.wake()
          } else {
            tracked.results.push(outcome.message)
          }
        }
      }
    } catch (error) {
      toolHadError = true
      const text = error instanceof Error ? error.message : String(error)
      tracked.results.push(
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: tracked.block.id,
              content: `<tool_use_error>${text}</tool_use_error>`,
              is_error: true,
            },
          ],
          toolUseResult: text,
          sourceToolAssistantUuid: tracked.assistantMessage.uuid,
        }),
      )
    } finally {
      tracked.status = 'completed'

      // Sibling cancellation is triggered ONLY by Bash / PowerShell errors!
      if (
        toolHadError &&
        CASCADING_ERROR_TOOL_NAMES.has(tracked.block.name) &&
        !this.hasErroredShell
      ) {
        this.hasErroredShell = true
        if (!this.siblingAbortController.signal.aborted) {
          this.siblingAbortController.abort('sibling_error')
        }
      }

      this.processQueue()
      this.wake()
    }
  }

  private *drainReadyUpdates(): Generator<ToolRunUpdate, void> {
    // 1. Always emit live progress immediately regardless of completion order
    while (this.progressQueue.length > 0) {
      const progressMsg = this.progressQueue.shift()!
      yield { message: progressMsg }
    }

    // 2. Emit completed tool results strictly in arrival order
    for (const tracked of this.tools) {
      if (tracked.status === 'yielded') {
        continue
      }
      if (tracked.status !== 'completed') {
        // Head-of-line barrier preserves exact tool_use arrival ordering
        break
      }

      for (const modifier of tracked.contextModifiers) {
        this.toolUseContext = modifier(this.toolUseContext)
        yield { newContext: this.toolUseContext }
      }
      for (const msg of tracked.results) {
        yield { message: msg }
      }
      tracked.status = 'yielded'
    }
  }

  /**
   * Non-blocking drain called mid-stream to flush any ready progress messages
   * and contiguous completed tool results.
   */
  *getCompletedResults(): Generator<ToolRunUpdate, void> {
    if (this.discarded) return
    yield* this.drainReadyUpdates()
  }

  /**
   * Async generator driving all remaining queued and executing tools to
   * completion, yielding live progress and ordered tool results.
   */
  async *getRemainingResults(): AsyncGenerator<ToolRunUpdate, void> {
    if (this.discarded) return
    this.processQueue()

    while (!this.discarded) {
      yield* this.drainReadyUpdates()

      const hasPending = this.tools.some(t => t.status !== 'yielded')
      if (!hasPending && this.progressQueue.length === 0) {
        break
      }

      this.processQueue()
      // Re-check synchronously in case processQueue cancelled/completed items
      const readyNow =
        this.progressQueue.length > 0 ||
        this.tools.some((t, idx) => {
          if (t.status !== 'completed') return false
          return this.tools.slice(0, idx).every(prev => prev.status === 'yielded')
        })
      if (readyNow) {
        continue
      }

      await this.waitForActivity()
    }
  }
}
