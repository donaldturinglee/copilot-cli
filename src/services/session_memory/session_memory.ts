/**
 * Post-sampling Session Memory background updater (`src/services/session_memory/session_memory.ts`):
 * - Triggers once the conversation reaches `10k` tokens, then on `+5k` token
 *   growth accompanied by `>= 3` tool calls or a natural turn break
 * - Runs a sequential cache-sharing forked agent confined strictly to editing
 *   `~/.copilot/projects/<project>/<sessionId>/session-memory/summary.md`
 * - Feeds Tier 4a (`trySessionMemoryCompaction`) with zero-LLM-call compaction summaries
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, normalize, resolve } from 'path'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools.js'
import type { QueryDeps } from '../../query/deps.js'
import type { AnyTool } from '../../tool.js'
import type { CanUseToolFn, ToolUseContext } from '../../types/forward.js'
import type { Message } from '../../types/message.js'
import { createCacheSafeParams } from '../../utilities/cache_safe_params.js'
import { logForDebugging } from '../../utilities/debug.js'
import { isBareMode, isEnvTruthy } from '../../utilities/env_utils.js'
import { getErrnoCode } from '../../utilities/errors.js'
import { runForkedAgent } from '../../utilities/forked_agent.js'
import {
  registerPostSamplingHook,
  type ReplHookContext,
} from '../../utilities/hooks/post_sampling_hooks.js'
import { logError } from '../../utilities/log.js'
import { createUserMessage } from '../../utilities/messages.js'
import { sequential } from '../../utilities/sequential.js'
import { asSystemPrompt } from '../../utilities/system_prompt_type.js'
import { tokenCountWithEstimation } from '../../utilities/tokens.js'
import { logEvent } from '../analytics/index.js'
import { isAutoCompactEnabled } from '../compact/auto_compact.js'
import {
  buildSessionMemoryUpdatePrompt,
  loadSessionMemoryTemplate,
} from './prompts.js'
import {
  getSessionMemoryPath,
  getToolCallsBetweenUpdates,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  isSessionMemoryInitialized,
  markExtractionCompleted,
  markExtractionStarted,
  markSessionMemoryInitialized,
  recordExtractionTokenCount,
  setLastSummarizedMessageId,
} from './session_memory_utils.js'

const MAX_SESSION_MEMORY_TURNS = 3

let lastMemoryMessageUuid: string | undefined
let unregisterPostSamplingHook: (() => void) | undefined

function normalizePathForCompare(filePath: string): string {
  const norm = normalize(resolve(filePath))
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

/**
 * Resets the incremental message cursor for session memory updates.
 */
export function resetLastMemoryMessageUuid(): void {
  lastMemoryMessageUuid = undefined
}

/**
 * Returns `true` if the most recent assistant message in `messages` contains
 * at least one `tool_use` block (meaning the turn is mid-tool-loop rather than
 * at a natural turn break).
 */
export function hasToolCallsInLastAssistantTurn(
  messages: readonly Message[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant') {
      return msg.message.content.some(block => block.type === 'tool_use')
    }
  }
  return false
}

/**
 * Counts assistant `tool_use` calls appearing after `sinceUuid`.
 */
export function countToolCallsSince(
  messages: readonly Message[],
  sinceUuid: string | undefined,
): number {
  let startIndex = 0
  if (sinceUuid) {
    const idx = messages.findIndex(m => m.uuid === sinceUuid)
    if (idx !== -1) {
      startIndex = idx + 1
    }
  }
  let count = 0
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') {
        count++
      }
    }
  }
  return count
}

/**
 * Evaluates whether Session Memory extraction should fire after the current turn:
 * - Initialization gate: `tokenCount >= 10k`
 * - Incremental update gate: token delta `>= 5k` AND (`toolCalls >= 3` OR natural turn break)
 */
export function shouldExtractMemory(messages: readonly Message[]): boolean {
  const currentTokens = tokenCountWithEstimation(messages)

  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(currentTokens)) {
      return false
    }
    markSessionMemoryInitialized()
    return true
  }

  if (!hasMetUpdateThreshold(currentTokens)) {
    return false
  }

  const toolCallsSinceLast = countToolCallsSince(messages, lastMemoryMessageUuid)
  const atNaturalBreak = !hasToolCallsInLastAssistantTurn(messages)
  return toolCallsSinceLast >= getToolCallsBetweenUpdates() || atNaturalBreak
}

/**
 * Strictly confines the forked session-memory updater to ONLY invoking `Edit`
 * on the exact session `summary.md` file path. All other tools and paths are denied.
 */
export function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn {
  const expectedPath = normalizePathForCompare(memoryPath)

  return async (tool, input) => {
    const anyTool = tool as Partial<AnyTool> | undefined
    const toolName = typeof anyTool?.name === 'string' ? anyTool.name : 'unknown'

    if (toolName === FILE_EDIT_TOOL_NAME) {
      const target = typeof input.file_path === 'string' ? input.file_path : ''
      if (target && normalizePathForCompare(target) === expectedPath) {
        return { behavior: 'allow', updatedInput: input }
      }
      return {
        behavior: 'deny',
        message: `Session memory updates may only edit ${memoryPath}.`,
        decisionReason: {
          type: 'other',
          reason: `Session memory updates may only edit ${memoryPath}`,
        },
      }
    }

    return {
      behavior: 'deny',
      message: `Tool "${toolName}" is not permitted during session memory extraction; only Edit on ${memoryPath} is allowed.`,
      decisionReason: {
        type: 'other',
        reason: `Tool "${toolName}" is not permitted during session memory extraction`,
      },
    }
  }
}

/**
 * Ensures `session-memory/summary.md` exists on disk with owner-only modes
 * (`0o700` dir, `0o600` file, `wx` exclusive creation) and returns its path and contents.
 */
export async function setupSessionMemoryFile(
  sessionId?: string,
  cwd?: string,
): Promise<{ memoryPath: string; currentNotes: string }> {
  const memoryPath = getSessionMemoryPath(sessionId, cwd)
  const dir = dirname(memoryPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })

  let currentNotes: string
  try {
    currentNotes = await readFile(memoryPath, 'utf8')
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error
    }
    const template = await loadSessionMemoryTemplate()
    try {
      await writeFile(memoryPath, template, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      currentNotes = template
    } catch (writeErr) {
      if (getErrnoCode(writeErr) === 'EEXIST') {
        currentNotes = await readFile(memoryPath, 'utf8')
      } else {
        throw writeErr
      }
    }
  }

  return { memoryPath, currentNotes }
}

async function runSessionMemoryExtraction(
  context: ReplHookContext,
  options?: { force?: boolean; deps?: QueryDeps },
): Promise<boolean> {
  if (context.toolUseContext.agentId) {
    return false
  }
  if (!options?.force && !shouldExtractMemory(context.messages)) {
    return false
  }
  if (context.messages.length === 0) {
    return false
  }

  markExtractionStarted()
  try {
    const { memoryPath, currentNotes } = await setupSessionMemoryFile()
    const updatePrompt = await buildSessionMemoryUpdatePrompt(
      currentNotes,
      memoryPath,
    )

    // Pre-seed readFileState so FileEditTool succeeds without an extra Read round-trip
    const readFileState = new Map<string, unknown>()
    readFileState.set(memoryPath, {
      content: currentNotes,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
    })

    await runForkedAgent({
      promptMessages: [createUserMessage({ content: updatePrompt })],
      cacheSafeParams: createCacheSafeParams({
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        userContext: context.userContext,
        systemContext: context.systemContext,
        toolUseContext: context.toolUseContext,
      }),
      canUseTool: createMemoryFileCanUseTool(memoryPath),
      querySource: 'session_memory',
      forkLabel: 'session_memory',
      skipTranscript: true,
      maxTurns: MAX_SESSION_MEMORY_TURNS,
      overrides: { readFileState },
      deps: options?.deps,
    })

    const currentTokens = tokenCountWithEstimation(context.messages)
    recordExtractionTokenCount(currentTokens)

    const lastMessage = context.messages.at(-1)
    if (lastMessage) {
      lastMemoryMessageUuid = lastMessage.uuid
      if (!hasToolCallsInLastAssistantTurn(context.messages)) {
        setLastSummarizedMessageId(lastMessage.uuid)
      }
    }

    logEvent('tengu_session_memory_extracted', {
      tokenCount: currentTokens,
      messageCount: context.messages.length,
    })
    return true
  } catch (error) {
    logError(error)
    return false
  } finally {
    markExtractionCompleted()
  }
}

/**
 * Serialized post-sampling session memory extractor.
 */
export const extractSessionMemory = sequential(
  async (
    context: ReplHookContext,
    options?: { force?: boolean; deps?: QueryDeps },
  ): Promise<boolean> => runSessionMemoryExtraction(context, options),
)

/**
 * Forces an immediate session memory extraction (bypassing token/tool thresholds).
 */
export async function manuallyExtractSessionMemory(
  messages: Message[],
  toolUseContext: ToolUseContext,
  options?: {
    systemPrompt?: ReplHookContext['systemPrompt']
    userContext?: Record<string, string>
    systemContext?: Record<string, string>
    deps?: QueryDeps
  },
): Promise<boolean> {
  return extractSessionMemory(
    {
      messages,
      systemPrompt: options?.systemPrompt ?? asSystemPrompt([]),
      userContext: options?.userContext ?? {},
      systemContext: options?.systemContext ?? {},
      toolUseContext,
      querySource: 'session_memory',
    },
    { force: true, deps: options?.deps },
  )
}

/**
 * Registers the Session Memory post-sampling hook when enabled.
 */
export function initSessionMemory(): void {
  if (unregisterPostSamplingHook) {
    return
  }
  if (
    isBareMode() ||
    getIsRemoteMode() ||
    isEnvTruthy(process.env.COPILOT_CLI_DISABLE_SESSION_MEMORY) ||
    !isAutoCompactEnabled()
  ) {
    logForDebugging('Session memory disabled for current mode')
    return
  }

  unregisterPostSamplingHook = registerPostSamplingHook(async context => {
    if (context.querySource !== 'repl_main_thread') {
      return
    }
    await extractSessionMemory(context)
  })
}

export function resetSessionMemoryHookForTesting(): void {
  unregisterPostSamplingHook?.()
  unregisterPostSamplingHook = undefined
  lastMemoryMessageUuid = undefined
}
