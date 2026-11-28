/**
 * Injectable I/O dependency bag (`QueryDeps`) for `query()`, keeping the
 * core turn state machine cleanly decoupled from compaction, tool execution,
 * hooks, and live API transport for deterministic unit testing.
 */

import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { QuerySource } from '../constants/query_source.js'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/auto_compact.js'
import { microcompactMessages } from '../services/compact/micro_compact.js'
import { runTools } from '../services/tools/tool_orchestration.js'
import { ensurePhase4HooksBootstrapped } from '../utilities/hooks/bootstrap_hooks.js'
import { handleStopHooks } from './stop_hooks.js'
import type {
  CanUseToolFn,
  CompactionResult,
  ToolUseContext,
} from '../types/forward.js'
import type {
  AssistantMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../types/message.js'
import type { CacheSafeParams } from '../utilities/cache_safe_params.js'
import { randomUUID } from '../utilities/crypto.js'
import type { SystemPrompt } from '../utilities/system_prompt_type.js'

export interface AutoCompactTrackingState {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
}

export interface MicrocompactResult {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: {
      trigger: 'auto'
      deletedToolIds: string[]
      baselineCacheDeletedTokens: number
    }
  }
}

export interface AutoCompactResult {
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}

export interface ToolRunUpdate {
  message?: Message
  newContext?: ToolUseContext
}

export interface StopHookResult {
  blockingErrors: Message[]
  preventContinuation: boolean
}

export interface QueryDeps {
  callModel: typeof queryModelWithStreaming
  microcompact: (
    messages: Message[],
    toolUseContext?: ToolUseContext,
    querySource?: QuerySource,
  ) => Promise<MicrocompactResult>
  autocompact: (
    messages: Message[],
    toolUseContext: ToolUseContext,
    cacheSafeParams: CacheSafeParams,
    querySource?: QuerySource,
    tracking?: AutoCompactTrackingState,
    snipTokensFreed?: number,
  ) => Promise<AutoCompactResult>
  uuid: () => string
  runTools?: (
    toolUseBlocks: BetaToolUseBlock[],
    assistantMessages: AssistantMessage[],
    canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) => AsyncGenerator<ToolRunUpdate, void>
  handleStopHooks?: (
    messagesForQuery: Message[],
    assistantMessages: AssistantMessage[],
    systemPrompt: SystemPrompt,
    userContext: Record<string, string>,
    systemContext: Record<string, string>,
    toolUseContext: ToolUseContext,
    querySource: QuerySource,
    stopHookActive?: boolean,
  ) => AsyncGenerator<
    | StreamEvent
    | RequestStartEvent
    | Message
    | TombstoneMessage
    | ToolUseSummaryMessage,
    StopHookResult
  >
}

/**
 * Constructs default production dependencies for `query()`, wired to the
 * Phase 7 multi-tier compaction pipeline (`microcompactMessages` +
 * `autoCompactIfNeeded`), tool orchestration, and Stop hooks.
 */
export function productionDeps(): QueryDeps {
  ensurePhase4HooksBootstrapped()
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: () => randomUUID(),
    runTools,
    handleStopHooks,
  }
}
