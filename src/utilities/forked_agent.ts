/**
 * Cache-sharing forked agent execution (`runForkedAgent`) and isolated
 * subagent context builder (`createSubagentContext`) reusing exact parent
 * prompt prefixes with `skipCacheWrite: true`.
 */

import type { QuerySource } from '../constants/query_source.js'
import { query } from '../query.js'
import type { QueryDeps } from '../query/deps.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'
import {
  accumulateUsage,
  EMPTY_USAGE,
  type NonNullableUsage,
  type PartialApiUsage,
  updateUsage,
} from '../services/api/empty_usage.js'
import type { AppState } from '../state/app_state_store.js'
import type { CanUseToolFn, ToolUseContext } from '../types/forward.js'
import type { Message } from '../types/message.js'
import { createChildAbortController } from './abort_controller.js'
import {
  type CacheSafeParams,
  createCacheSafeParams,
  getLastCacheSafeParams,
  saveCacheSafeParams,
} from './cache_safe_params.js'
import { randomUUID } from './crypto.js'
import { getAssistantMessageText } from './messages.js'

export {
  createCacheSafeParams,
  getLastCacheSafeParams,
  saveCacheSafeParams,
  type CacheSafeParams,
}

export interface SubagentContextOverrides {
  abortController?: AbortController
  shareAbortController?: boolean
  shareSetAppState?: boolean
  getAppState?: () => AppState
  readFileState?: Map<string, unknown>
  contentReplacementState?: unknown
  agentId?: string
}

export interface ForkedAgentParams {
  promptMessages: Message[]
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  querySource: QuerySource
  forkLabel: string
  overrides?: SubagentContextOverrides
  maxOutputTokens?: number
  maxTurns?: number
  onMessage?: (message: Message) => void
  skipTranscript?: boolean
  skipCacheWrite?: boolean
  deps?: QueryDeps
}

export interface ForkedAgentResult {
  messages: Message[]
  totalUsage: NonNullableUsage
}

function createForkAgentId(label?: string): string {
  const short = randomUUID().replace(/-/g, '').slice(0, 12)
  return label ? `fork_${label}_${short}` : `fork_${short}`
}

function cloneMapIfPresent(value: unknown): Map<string, unknown> | undefined {
  if (value instanceof Map) {
    return new Map(value)
  }
  return undefined
}

/**
 * Creates an isolated `ToolUseContext` for a forked/subagent turn so mutable
 * state (abort controllers, readFileState, nested memory triggers, UI callbacks)
 * cannot leak back into the parent turn.
 */
export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext {
  const abortController =
    overrides?.abortController ??
    (overrides?.shareAbortController
      ? parentContext.abortController
      : createChildAbortController(parentContext.abortController))

  const parentGetAppState = parentContext.getAppState as
    | (() => AppState)
    | undefined
  const getAppState =
    overrides?.getAppState ??
    (overrides?.shareAbortController
      ? parentGetAppState
      : parentGetAppState
        ? () => {
            const state = parentGetAppState()
            return {
              ...state,
              toolPermissionContext: {
                ...state.toolPermissionContext,
                shouldAvoidPermissionPrompts: true,
              },
            }
          }
        : undefined)

  const parentSetAppState = parentContext.setAppState as
    | ((updater: (prev: AppState) => AppState) => void)
    | undefined
  const setAppState = overrides?.shareSetAppState
    ? parentSetAppState
    : () => {}

  const readFileState =
    overrides?.readFileState ??
    cloneMapIfPresent(parentContext.readFileState) ??
    new Map<string, unknown>()

  const parentTracking = parentContext.queryTracking as
    | { chainId: string; depth: number }
    | undefined

  return {
    ...parentContext,
    abortController,
    ...(getAppState ? { getAppState } : {}),
    setAppState,
    setAppStateForTasks:
      parentContext.setAppStateForTasks ?? parentSetAppState,
    readFileState,
    contentReplacementState:
      overrides?.contentReplacementState ??
      parentContext.contentReplacementState,
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
    toolDecisions: undefined,
    agentId: overrides?.agentId ?? createForkAgentId(),
    queryTracking: {
      chainId: randomUUID(),
      depth: (parentTracking?.depth ?? -1) + 1,
    },
  }
}

/**
 * Runs a forked agent sharing the parent's byte-identical system prompt,
 * tools, and message prefix (defaulting `skipCacheWrite: true` so the fork tail
 * does not pollute KV cache).
 */
export async function runForkedAgent(
  params: ForkedAgentParams,
): Promise<ForkedAgentResult> {
  const {
    promptMessages,
    cacheSafeParams,
    canUseTool,
    querySource,
    forkLabel,
    overrides,
    maxOutputTokens,
    maxTurns,
    onMessage,
    skipCacheWrite = true,
    deps,
  } = params

  const isolatedContext = createSubagentContext(
    cacheSafeParams.toolUseContext,
    {
      ...overrides,
      agentId: overrides?.agentId ?? createForkAgentId(forkLabel),
    },
  )

  const initialMessages: Message[] = [
    ...cacheSafeParams.forkContextMessages,
    ...promptMessages,
  ]

  const outputMessages: Message[] = []
  let totalUsage: NonNullableUsage = { ...EMPTY_USAGE }

  try {
    for await (const event of query({
      messages: initialMessages,
      systemPrompt: cacheSafeParams.systemPrompt,
      userContext: cacheSafeParams.userContext,
      systemContext: cacheSafeParams.systemContext,
      canUseTool,
      toolUseContext: isolatedContext,
      querySource,
      maxOutputTokensOverride: maxOutputTokens,
      maxTurns,
      skipCacheWrite,
      deps,
    })) {
      if (event.type === 'stream_event') {
        if (
          event.event.type === 'message_delta' &&
          'usage' in event.event &&
          event.event.usage
        ) {
          const turnUsage = updateUsage(
            { ...EMPTY_USAGE },
            event.event.usage as unknown as PartialApiUsage,
          )
          totalUsage = accumulateUsage(totalUsage, turnUsage)
        }
        continue
      }
      if (
        event.type === 'stream_request_start' ||
        event.type === 'tombstone' ||
        event.type === 'tool_use_summary'
      ) {
        continue
      }

      outputMessages.push(event)
      onMessage?.(event)

      // Account for non-streaming / mock assistant responses that bypass stream_event
      if (
        event.type === 'assistant' &&
        event.message.usage &&
        totalUsage.output_tokens === 0 &&
        totalUsage.input_tokens === 0
      ) {
        const turnUsage = updateUsage(
          { ...EMPTY_USAGE },
          event.message.usage as unknown as PartialApiUsage,
        )
        totalUsage = accumulateUsage(totalUsage, turnUsage)
      }
    }
  } finally {
    const rfs = isolatedContext.readFileState
    if (rfs instanceof Map) {
      rfs.clear()
    }
    initialMessages.length = 0
  }

  const totalInputTokens =
    totalUsage.input_tokens +
    totalUsage.cache_creation_input_tokens +
    totalUsage.cache_read_input_tokens
  const cacheHitRate =
    totalInputTokens > 0
      ? totalUsage.cache_read_input_tokens / totalInputTokens
      : 0

  logEvent('tengu_fork_agent_query', {
    forkLabel: forkLabel as VerifiedNonSensitiveAnalyticsMetadata,
    querySource: querySource as VerifiedNonSensitiveAnalyticsMetadata,
    cacheHitRate,
    inputTokens: totalUsage.input_tokens,
    outputTokens: totalUsage.output_tokens,
    cacheReadTokens: totalUsage.cache_read_input_tokens,
    cacheCreationTokens: totalUsage.cache_creation_input_tokens,
  })

  return {
    messages: outputMessages,
    totalUsage,
  }
}

/**
 * Extracts concatenated assistant text from forked agent output messages.
 */
export function extractResultText(
  agentMessages: readonly Message[],
  defaultText = 'Execution completed',
): string {
  const parts: string[] = []
  for (const msg of agentMessages) {
    if (msg.type === 'assistant') {
      const text = getAssistantMessageText(msg).trim()
      if (text) {
        parts.push(text)
      }
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : defaultText
}

/**
 * Wraps `getAppState` to restrict active allow-rules for a forked agent.
 */
export function createGetAppStateWithAllowedTools(
  baseGetAppState: () => AppState,
  allowedTools: readonly string[],
): () => AppState {
  return () => {
    const base = baseGetAppState()
    return {
      ...base,
      toolPermissionContext: {
        ...base.toolPermissionContext,
        alwaysAllowRules: {
          ...base.toolPermissionContext.alwaysAllowRules,
          session: [...allowedTools],
        },
      },
    }
  }
}
