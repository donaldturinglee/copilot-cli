/**
 * Stop-hook forked persistent memory extractor (`extractMemories`):
 * - Restricted tool permissions (`createAutoMemCanUseTool`) allowing read-only
 *   inspection plus Edit/Write strictly confined inside `getAutoMemPath()`
 * - Cursor tracking (`lastMemoryMessageUuid`) with retry-on-failure semantics
 * - Mutually-exclusive skip if the main agent already wrote to `memdir`
 * - Overlap coalescing (at most 1 trailing run) and graceful shutdown draining
 */

import type { UUID } from 'crypto'
import { basename } from 'path'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import {
  BASH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
} from '../../constants/tools.js'
import { ENTRYPOINT_NAME } from '../../memdir/memdir.js'
import { formatMemoryManifest, scanMemoryFiles } from '../../memdir/memory_scan.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
  isAutoMemPath,
  isExtractModeActive,
} from '../../memdir/paths.js'
import { isTeamMemoryEnabled, isTeamMemPath } from '../../memdir/team_mem_paths.js'
import type { QueryDeps } from '../../query/deps.js'
import type { AnyTool } from '../../tool.js'
import type { CanUseToolFn, ToolUseContext } from '../../types/forward.js'
import type {
  Message,
  SystemMemorySavedMessage,
  SystemMessage,
} from '../../types/message.js'
import { createCacheSafeParams } from '../../utilities/cache_safe_params.js'
import { randomUUID } from '../../utilities/crypto.js'
import { isFeatureEnabled } from '../../utilities/feature_flags.js'
import { runForkedAgent } from '../../utilities/forked_agent.js'
import { createUserMessage } from '../../utilities/messages.js'
import type { SystemPrompt } from '../../utilities/system_prompt_type.js'
import { getFeatureValueCachedMayBeStale } from '../analytics/growthbook.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../analytics/index.js'
import {
  buildExtractAutoOnlyPrompt,
  buildExtractCombinedPrompt,
} from './prompts.js'

const MAX_EXTRACT_TURNS = 5

export interface ExtractMemoriesContext {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
}

export type AppendSystemMessageFn = (message: SystemMessage) => void

/**
 * Creates a `memory_saved` system notification message.
 */
export function createMemorySavedMessage(
  writtenPaths: string[],
  options?: { teamCount?: number; verb?: string },
): SystemMemorySavedMessage {
  return {
    type: 'system',
    subtype: 'memory_saved',
    writtenPaths,
    ...(options?.teamCount !== undefined ? { teamCount: options.teamCount } : {}),
    ...(options?.verb ? { verb: options.verb } : {}),
    uuid: randomUUID() as UUID,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Shared sandboxed permission predicate for `extractMemories` and `autoDream`:
 * - Allows `Read`, `Grep`, `Glob`
 * - Allows `Bash` ONLY when the tool's own `isReadOnly(parsedInput)` returns `true`
 * - Allows `Edit` / `Write` ONLY when `file_path` resolves strictly inside `memoryDir`
 * - Denies all other tools (including out-of-bounds project writes, MCP, Agent, write Bash)
 */
export function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn {
  const allowedReadOnlyTools = new Set([
    FILE_READ_TOOL_NAME,
    GREP_TOOL_NAME,
    GLOB_TOOL_NAME,
  ])

  const isTargetInsideDir = (filePath: string): boolean => {
    // Support both the canonical auto-mem path and custom injected memoryDir (tests)
    if (isAutoMemPath(filePath)) {
      return true
    }
    const normTarget = filePath.replace(/\\/g, '/')
    const normDir = memoryDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    if (process.platform === 'win32') {
      return normTarget.toLowerCase().startsWith(normDir.toLowerCase())
    }
    return normTarget.startsWith(normDir)
  }

  return async (tool, input) => {
    const anyTool = tool as Partial<AnyTool> | undefined
    const toolName = typeof anyTool?.name === 'string' ? anyTool.name : 'unknown'

    if (allowedReadOnlyTools.has(toolName)) {
      return { behavior: 'allow', updatedInput: input }
    }

    if (toolName === BASH_TOOL_NAME) {
      try {
        if (anyTool?.inputSchema && typeof anyTool.isReadOnly === 'function') {
          const parsed = anyTool.inputSchema.safeParse(input)
          if (parsed.success && anyTool.isReadOnly(parsed.data as never)) {
            return { behavior: 'allow', updatedInput: input }
          }
        }
      } catch {
        // Fall through to deny
      }
      logEvent('tengu_auto_mem_tool_denied', {
        tool: BASH_TOOL_NAME as VerifiedNonSensitiveAnalyticsMetadata,
      })
      return {
        behavior: 'deny',
        message:
          'Only read-only shell commands are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)',
        decisionReason: {
          type: 'other',
          reason: 'Only read-only shell commands are permitted during memory operations',
        },
      }
    }

    if (toolName === FILE_EDIT_TOOL_NAME || toolName === FILE_WRITE_TOOL_NAME) {
      const filePath =
        typeof input.file_path === 'string' ? input.file_path : ''
      if (filePath && isTargetInsideDir(filePath)) {
        return { behavior: 'allow', updatedInput: input }
      }
      logEvent('tengu_auto_mem_tool_denied', {
        tool: toolName as VerifiedNonSensitiveAnalyticsMetadata,
      })
      return {
        behavior: 'deny',
        message: `Writes are strictly restricted to the memory directory (${memoryDir}); out-of-bounds project writes are forbidden.`,
        decisionReason: {
          type: 'other',
          reason: 'Write path outside memory directory',
        },
      }
    }

    logEvent('tengu_auto_mem_tool_denied', {
      tool: toolName as VerifiedNonSensitiveAnalyticsMetadata,
    })
    return {
      behavior: 'deny',
      message: `Tool "${toolName}" is not permitted during background memory operations.`,
      decisionReason: {
        type: 'other',
        reason: `Tool "${toolName}" is not permitted during background memory operations`,
      },
    }
  }
}

function sliceMessagesAfterCursor(
  messages: readonly Message[],
  sinceUuid: string | undefined,
): readonly Message[] {
  if (!sinceUuid) {
    return messages
  }
  const idx = messages.findIndex(m => m.uuid === sinceUuid)
  // If cursor was compacted away, fall back to full active slice so extraction never stalls
  if (idx === -1) {
    return messages
  }
  return messages.slice(idx + 1)
}

export function countModelVisibleMessagesSince(
  messages: readonly Message[],
  sinceUuid: string | undefined,
): number {
  const slice = sliceMessagesAfterCursor(messages, sinceUuid)
  let count = 0
  for (const msg of slice) {
    if (msg.type === 'user' || msg.type === 'assistant') {
      count++
    }
  }
  return count
}

export function hasMemoryWritesSince(
  messages: readonly Message[],
  sinceUuid: string | undefined,
): boolean {
  const slice = sliceMessagesAfterCursor(messages, sinceUuid)
  for (const msg of slice) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        (block.name === FILE_EDIT_TOOL_NAME ||
          block.name === FILE_WRITE_TOOL_NAME) &&
        block.input &&
        typeof block.input === 'object' &&
        typeof (block.input as { file_path?: unknown }).file_path === 'string'
      ) {
        if (isAutoMemPath((block.input as { file_path: string }).file_path)) {
          return true
        }
      }
    }
  }
  return false
}

function extractWrittenPaths(agentMessages: readonly Message[]): string[] {
  const paths = new Set<string>()
  for (const msg of agentMessages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        (block.name === FILE_EDIT_TOOL_NAME ||
          block.name === FILE_WRITE_TOOL_NAME) &&
        block.input &&
        typeof block.input === 'object' &&
        typeof (block.input as { file_path?: unknown }).file_path === 'string'
      ) {
        paths.add((block.input as { file_path: string }).file_path)
      }
    }
  }
  return Array.from(paths)
}

interface ExtractorRuntime {
  inFlight: Set<Promise<void>>
  lastMemoryMessageUuid: string | undefined
  inProgress: boolean
  turnsSinceLastExtraction: number
  pendingContext:
    | {
        context: ExtractMemoriesContext
        appendSystemMessage?: AppendSystemMessageFn
        deps?: QueryDeps
      }
    | undefined
}

let runtime: ExtractorRuntime | null = null

function ensureRuntime(): ExtractorRuntime {
  if (!runtime) {
    runtime = {
      inFlight: new Set(),
      lastMemoryMessageUuid: undefined,
      inProgress: false,
      turnsSinceLastExtraction: 0,
      pendingContext: undefined,
    }
  }
  return runtime
}

/**
 * Initializes the Stop-hook memory extractor state.
 */
export function initExtractMemories(): void {
  ensureRuntime()
}

export function resetExtractMemoriesForTesting(): void {
  runtime = null
}

async function runSingleExtraction(
  state: ExtractorRuntime,
  context: ExtractMemoriesContext,
  appendSystemMessage?: AppendSystemMessageFn,
  deps?: QueryDeps,
  bypassThrottle = false,
): Promise<void> {
  const throttleTurns = Math.max(
    1,
    getFeatureValueCachedMayBeStale<number>('tengu_bramble_lintel', 1),
  )

  if (!bypassThrottle) {
    state.turnsSinceLastExtraction++
    if (state.turnsSinceLastExtraction < throttleTurns) {
      return
    }
    state.turnsSinceLastExtraction = 0
  }

  const messages = context.messages
  if (messages.length === 0) return

  if (hasMemoryWritesSince(messages, state.lastMemoryMessageUuid)) {
    state.lastMemoryMessageUuid = messages.at(-1)?.uuid
    logEvent('tengu_extract_memories_skipped_direct_write', {})
    return
  }

  const newMessageCount = countModelVisibleMessagesSince(
    messages,
    state.lastMemoryMessageUuid,
  )
  if (newMessageCount === 0) {
    return
  }

  const memoryDir = getAutoMemPath()
  const existingHeaders = await scanMemoryFiles(
    memoryDir,
    context.toolUseContext.abortController.signal,
  )
  const manifest = formatMemoryManifest(existingHeaders)
  const skipIndex = getFeatureValueCachedMayBeStale('tengu_moth_copse', false)
  const useCombined = isFeatureEnabled('TEAMMEM') && isTeamMemoryEnabled()
  const promptText = useCombined
    ? buildExtractCombinedPrompt(newMessageCount, manifest, skipIndex)
    : buildExtractAutoOnlyPrompt(newMessageCount, manifest, skipIndex)

  const forkRes = await runForkedAgent({
    promptMessages: [createUserMessage({ content: promptText })],
    cacheSafeParams: createCacheSafeParams({
      messages,
      systemPrompt: context.systemPrompt,
      userContext: context.userContext,
      systemContext: context.systemContext,
      toolUseContext: context.toolUseContext,
    }),
    canUseTool: createAutoMemCanUseTool(memoryDir),
    querySource: 'extract_memories',
    forkLabel: 'extract_memories',
    skipTranscript: true,
    maxTurns: MAX_EXTRACT_TURNS,
    deps,
  })

  // Advance cursor only on success so failures retry on the next turn
  state.lastMemoryMessageUuid = messages.at(-1)?.uuid

  const written = extractWrittenPaths(forkRes.messages)
  const visibleWritten = written.filter(
    p => basename(p).toUpperCase() !== ENTRYPOINT_NAME.toUpperCase(),
  )
  if (visibleWritten.length > 0 && appendSystemMessage) {
    const teamCount = isFeatureEnabled('TEAMMEM')
      ? visibleWritten.filter(p => isTeamMemPath(p)).length
      : undefined
    appendSystemMessage(
      createMemorySavedMessage(visibleWritten, { teamCount }),
    )
  }
}

/**
 * Invoked from `handleStopHooks` at the end of a main-thread turn.
 * Coalesces overlapping calls into at most one trailing run.
 */
export async function executeExtractMemories(
  context: ExtractMemoriesContext,
  appendSystemMessage?: AppendSystemMessageFn,
  options?: { deps?: QueryDeps; force?: boolean },
): Promise<void> {
  if (context.toolUseContext.agentId) {
    return
  }
  if (!options?.force && (!isExtractModeActive() || getIsRemoteMode())) {
    return
  }
  if (!isAutoMemoryEnabled()) {
    return
  }

  const state = ensureRuntime()
  if (state.inProgress) {
    state.pendingContext = {
      context,
      appendSystemMessage,
      deps: options?.deps,
    }
    return
  }

  state.inProgress = true
  const taskPromise = (async () => {
    try {
      await runSingleExtraction(
        state,
        context,
        appendSystemMessage,
        options?.deps,
        Boolean(options?.force),
      )
    } finally {
      const trailing = state.pendingContext
      state.pendingContext = undefined
      if (trailing) {
        try {
          await runSingleExtraction(
            state,
            trailing.context,
            trailing.appendSystemMessage,
            trailing.deps,
            true,
          )
        } finally {
          state.inProgress = false
        }
      } else {
        state.inProgress = false
      }
    }
  })()

  state.inFlight.add(taskPromise)
  try {
    await taskPromise
  } finally {
    state.inFlight.delete(taskPromise)
  }
}

/**
 * Waits for any in-flight background memory extractions to finish before
 * headless CLI shutdown (default 60s timeout, unref'd timer).
 */
export async function drainPendingExtraction(
  timeoutMs = 60_000,
): Promise<void> {
  if (!runtime || runtime.inFlight.size === 0) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(Array.from(runtime.inFlight)),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
