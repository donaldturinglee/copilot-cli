/**
 * Core agent turn state machine (`query()`):
 * Explicit `while (true)` loop over immutable `State` with injectable `QueryDeps`:
 * - Reserves microcompact, autocompact, tool-execution, and stop-hook slots.
 * - Handles `FallbackTriggeredError` model switching & mid-stream fallback tombstones.
 * - Withholds recoverable `max_output_tokens` errors for ceiling escalation (8k -> 64k)
 *   and up to 3 multi-turn continuation nudges.
 * - Snapshots `CacheSafeParams` for cache-sharing forks (`runForkedAgent`).
 * - Enforces `maxTurns` and turn token-budget continuation (`<90%` without
 *   diminishing returns).
 */

import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import type { QuerySource } from './constants/query_source.js'
import { buildQueryConfig } from './query/config.js'
import {
  type AutoCompactTrackingState,
  productionDeps,
  type QueryDeps,
} from './query/deps.js'
import {
  checkTokenBudget,
  createBudgetTracker,
} from './query/token_budget.js'
import type { Continue, Terminal } from './query/transitions.js'
import { getFeatureValueCachedMayBeStale } from './services/analytics/growthbook.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from './services/analytics/index.js'
import { createDumpPromptsFetch } from './services/api/dump_prompts.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from './services/api/errors.js'
import { FallbackTriggeredError } from './services/api/with_retry.js'
import { calculateTokenWarningState } from './services/compact/auto_compact.js'
import { StreamingToolExecutor } from './services/tools/streaming_tool_executor.js'
import type { AppState } from './state/app_state_store.js'
import type { AnyTool, ToolUseContext as FullToolUseContext } from './tool.js'
import type {
  CanUseToolFn,
  CompactionResult,
  Tool,
  ToolUseContext,
} from './types/forward.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from './types/message.js'
import type { PermissionMode } from './types/permissions.js'
import { appendSystemContext, prependUserContext } from './utilities/api.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from './utilities/attachments.js'
import { saveCacheSafeParams } from './utilities/cache_safe_params.js'
import { ESCALATED_MAX_TOKENS } from './utilities/context.js'
import { logForDebugging } from './utilities/debug.js'
import { isBareMode, isEnvTruthy } from './utilities/env_utils.js'
import { isFeatureEnabled } from './utilities/feature_flags.js'
import { headlessProfilerCheckpoint } from './utilities/headless_profiler.js'
import { runPostSamplingHooks } from './utilities/hooks/post_sampling_hooks.js'
import { logError } from './utilities/log.js'
import {
  createAssistantApiErrorMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
  getMessagesAfterCompactBoundary,
  ImageResizeError,
  ImageSizeError,
  normalizeMessagesForApi,
  stripSignatureBlocks,
} from './utilities/messages.js'
import {
  getDefaultMainLoopModel,
  getRuntimeMainLoopModel,
  renderModelName,
} from './utilities/model/model.js'
import { queryCheckpoint } from './utilities/query_profiler.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from './utilities/system_prompt_type.js'
import type { ThinkingConfig } from './utilities/thinking.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utilities/tokens.js'
import { recordContentReplacement } from './utilities/session_storage.js'
import {
  applyToolResultBudget,
  provisionContentReplacementState,
} from './utilities/tool_result_storage.js'

export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

export const MAX_OUTPUT_TOKENS_RECOVERY_PROMPT =
  'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
  'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.'

export interface QueryToolUseOptions {
  mainLoopModel?: string
  tools?: readonly Tool[]
  thinkingConfig?: ThinkingConfig
  isNonInteractiveSession?: boolean
  hasAppendSystemPrompt?: boolean
  refreshTools?: () => readonly Tool[]
}

export interface QueryParams {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  taskBudget?: { total: number }
  deps?: QueryDeps
}

export type QueryEvent =
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage

interface LoopState {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}

function isWithheldMaxOutputTokens(
  msg: QueryEvent | undefined,
): msg is AssistantMessage {
  return (
    msg !== undefined &&
    msg.type === 'assistant' &&
    msg.apiError === 'max_output_tokens'
  )
}

function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}

function* yieldMissingToolResultBlocks(
  assistantMessages: readonly AssistantMessage[],
  errorMessage: string,
): Generator<UserMessage, void> {
  for (const assistantMsg of assistantMessages) {
    for (const block of assistantMsg.message.content) {
      if (block.type === 'tool_use') {
        yield createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: errorMessage,
              is_error: true,
              tool_use_id: block.id,
            },
          ],
          toolUseResult: errorMessage,
          sourceToolAssistantUuid: assistantMsg.uuid,
        })
      }
    }
  }
}

function getContextOptions(ctx: ToolUseContext): QueryToolUseOptions {
  return (ctx.options as QueryToolUseOptions | undefined) ?? {}
}

function getContextAppState(ctx: ToolUseContext): AppState | undefined {
  const getter = ctx.getAppState as (() => AppState) | undefined
  return getter?.()
}

function getPermissionModeFromContext(ctx: ToolUseContext): PermissionMode {
  return getContextAppState(ctx)?.toolPermissionContext.mode ?? 'default'
}

async function* queryLoop(
  params: QueryParams,
): AsyncGenerator<QueryEvent, Terminal> {
  const deps = params.deps ?? productionDeps()
  const config = buildQueryConfig()
  const budgetTracker = isFeatureEnabled('TOKEN_BUDGET')
    ? createBudgetTracker()
    : null
  let taskBudgetRemaining: number | undefined

  let state: LoopState = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    autoCompactTracking: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    pendingToolUseSummary: undefined,
    stopHookActive: undefined,
    turnCount: 1,
    transition: undefined,
  }

  while (true) {
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state
    let toolUseContext = state.toolUseContext

    yield { type: 'stream_request_start' }
    queryCheckpoint('query_fn_entry')
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    const prevTracking = toolUseContext.queryTracking as
      | { chainId: string; depth: number }
      | undefined
    const queryTracking = prevTracking
      ? { chainId: prevTracking.chainId, depth: prevTracking.depth + 1 }
      : { chainId: deps.uuid(), depth: 0 }
    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
    let tracking = autoCompactTracking
    const snipTokensFreed = 0

    // Tier 0: Enforce aggregate per-message tool-result budget with frozen ContentReplacementState
    const contentReplacementState = provisionContentReplacementState(
      toolUseContext as FullToolUseContext,
    )
    const ctxOptionsForBudget = getContextOptions(toolUseContext)
    const budgeted = await applyToolResultBudget(
      messagesForQuery,
      contentReplacementState,
      ctxOptionsForBudget.tools as readonly AnyTool[] | undefined,
    )
    messagesForQuery = budgeted.messages
    if (
      budgeted.replacedIds.length > 0 &&
      (params.querySource === 'repl_main_thread' ||
        params.querySource === 'sdk' ||
        params.querySource.startsWith('agent:'))
    ) {
      const replacedSet = new Set(budgeted.replacedIds)
      const newRecords = contentReplacementState.records.filter(r =>
        replacedSet.has(r.toolUseId),
      )
      if (newRecords.length > 0) {
        void recordContentReplacement(newRecords).catch(err => logError(err))
      }
    }
    toolUseContext = { ...toolUseContext, messages: messagesForQuery }

    // Tier 2a: Pre-API microcompact (time-based idle clearing)
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      params.querySource,
    )
    messagesForQuery = microcompactResult.messages
    queryCheckpoint('query_microcompact_end')

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(params.systemPrompt, params.systemContext),
    )

    // Tier 4: Pre-API autocompact (Session Memory Tier 4a -> Full LLM Tier 4b)
    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt: params.systemPrompt,
        userContext: params.userContext,
        systemContext: params.systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      params.querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messagesForQuery.length,
        preCompactTokenCount: compactionResult.preCompactTokenCount ?? 0,
        postCompactTokenCount: compactionResult.postCompactTokenCount ?? 0,
        queryDepth: queryTracking.depth,
      })

      if (params.taskBudget) {
        const lastContextTokens =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - lastContextTokens,
        )
      }

      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }
      const postCompactMessages = buildPostCompactMessages(compactionResult)
      for (const compactedMsg of postCompactMessages) {
        yield compactedMsg
      }
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    toolUseContext = { ...toolUseContext, messages: messagesForQuery }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: Array<UserMessage | AttachmentMessage> = []
    const toolUseBlocks: BetaToolUseBlock[] = []
    let needsFollowUp = false
    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    // Use StreamingToolExecutor mid-stream unless caller injected a custom runTools mock
    const useStreamingExecutor =
      !params.deps?.runTools &&
      !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_STREAMING_TOOL_EXECUTION)
    let streamingExecutor: StreamingToolExecutor | null = useStreamingExecutor
      ? new StreamingToolExecutor(
          params.canUseTool,
          toolUseContext as FullToolUseContext,
        )
      : null

    queryCheckpoint('query_setup_start')
    const ctxOptions = getContextOptions(toolUseContext)
    const configuredMainModel =
      ctxOptions.mainLoopModel ?? getDefaultMainLoopModel()
    const permissionMode = getPermissionModeFromContext(toolUseContext)
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: configuredMainModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })
    queryCheckpoint('query_setup_end')

    // Hard blocking limit check
    if (
      !compactionResult &&
      params.querySource !== 'compact' &&
      params.querySource !== 'session_memory'
    ) {
      const warningState = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        configuredMainModel,
      )
      if (warningState.isAtBlockingLimit) {
        yield createAssistantApiErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    // Model streaming & fallback retry loop
    let attemptWithFallback = true
    queryCheckpoint('query_api_loop_start')

    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        let streamingFallbackOccurred = false
        queryCheckpoint('query_api_streaming_start')

        try {
          const appState = getContextAppState(toolUseContext)
          const thinkingConfig: ThinkingConfig = ctxOptions.thinkingConfig ?? {
            type: 'adaptive',
          }
          const tools = ctxOptions.tools ?? []

          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, params.userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig,
            tools,
            signal: toolUseContext.abortController.signal,
            options: {
              model: currentModel,
              getToolPermissionContext: appState
                ? () => appState.toolPermissionContext
                : undefined,
              ...(config.gates.fastModeEnabled
                ? { fastMode: appState?.fastMode }
                : {}),
              isNonInteractiveSession: ctxOptions.isNonInteractiveSession,
              fallbackModel: params.fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccurred = true
              },
              querySource: params.querySource,
              hasAppendSystemPrompt: ctxOptions.hasAppendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: createDumpPromptsFetch(),
              effortValue: appState?.effortValue,
              advisorModel: appState?.advisorModel,
              skipCacheWrite: params.skipCacheWrite,
              agentId:
                typeof toolUseContext.agentId === 'string'
                  ? toolUseContext.agentId
                  : undefined,
              ...(params.taskBudget
                ? {
                    taskBudget: {
                      total: params.taskBudget.total,
                      ...(taskBudgetRemaining !== undefined
                        ? { remaining: taskBudgetRemaining }
                        : {}),
                    },
                  }
                : {}),
            },
          })) {
            if (streamingFallbackOccurred) {
              streamingFallbackOccurred = false
              streamingExecutor?.discard()
              streamingExecutor = useStreamingExecutor
                ? new StreamingToolExecutor(
                    params.canUseTool,
                    toolUseContext as FullToolUseContext,
                  )
                : null
              for (const orphaned of assistantMessages) {
                yield { type: 'tombstone', message: orphaned }
              }
              if (assistantMessages.length > 0) {
                logEvent('tengu_orphaned_messages_tombstoned', {
                  count: assistantMessages.length,
                })
              }
              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false
            }

            const withheld = isWithheldMaxOutputTokens(message)
            if (!withheld) {
              yield message
            }

            if (message.type === 'assistant') {
              assistantMessages.push(message)
              const msgToolUses = message.message.content.filter(
                (block): block is BetaToolUseBlock => block.type === 'tool_use',
              )
              if (msgToolUses.length > 0) {
                toolUseBlocks.push(...msgToolUses)
                needsFollowUp = true
                if (streamingExecutor) {
                  for (const block of msgToolUses) {
                    streamingExecutor.addTool(block, message)
                  }
                  for (const update of streamingExecutor.getCompletedResults()) {
                    if (update.message) {
                      yield update.message
                      if (
                        update.message.type === 'attachment' &&
                        update.message.attachment.type ===
                          'hook_stopped_continuation'
                      ) {
                        shouldPreventContinuation = true
                      }
                      const normalized = normalizeMessagesForApi(
                        [update.message],
                        ctxOptions.tools,
                      ).filter((m): m is UserMessage => m.type === 'user')
                      toolResults.push(...normalized)
                    }
                    if (update.newContext) {
                      updatedToolUseContext = {
                        ...update.newContext,
                        queryTracking,
                      }
                    }
                  }
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')
        } catch (innerError) {
          if (
            innerError instanceof FallbackTriggeredError &&
            params.fallbackModel
          ) {
            currentModel = params.fallbackModel
            attemptWithFallback = true
            streamingExecutor?.discard()
            streamingExecutor = useStreamingExecutor
              ? new StreamingToolExecutor(
                  params.canUseTool,
                  toolUseContext as FullToolUseContext,
                )
              : null

            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            if (ctxOptions) {
              ctxOptions.mainLoopModel = params.fallbackModel
            }
            if (config.gates.isAnt) {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as VerifiedNonSensitiveAnalyticsMetadata,
              fallback_model:
                innerError.fallbackModel as VerifiedNonSensitiveAnalyticsMetadata,
              entrypoint: 'cli' as VerifiedNonSensitiveAnalyticsMetadata,
              queryDepth: queryTracking.depth,
            })

            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )
            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      logEvent('tengu_query_error', {
        querySource:
          params.querySource as VerifiedNonSensitiveAnalyticsMetadata,
      })
      if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
        yield createAssistantApiErrorMessage({ content: error.message })
        return { reason: 'image_error' }
      }
      const errMsg = error instanceof Error ? error.message : String(error)
      yield* yieldMissingToolResultBlocks(assistantMessages, errMsg)
      yield createAssistantApiErrorMessage({ content: errMsg })
      return { reason: 'model_error', error }
    }

    // Streaming abort check
    if (toolUseContext.abortController.signal.aborted) {
      streamingExecutor?.discard()
      yield* yieldMissingToolResultBlocks(
        assistantMessages,
        'Interrupted by user',
      )
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({ toolUse: false })
      }
      return { reason: 'aborted_streaming' }
    }

    // Flush pending tool-use summary if any
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    // No tool calls -> check recoverable errors, save CacheSafeParams, stop hooks, token budget
    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      if (isWithheldMaxOutputTokens(lastMessage)) {
        const capEnabled = getFeatureValueCachedMayBeStale(
          'tengu_otk_slot_v1',
          false,
        )
        // 1. Ceiling escalation (8k -> 64k) without burning a turn
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.COPILOT_CLI_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          state = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          continue
        }

        // 2. Multi-turn continuation nudge (up to 3 attempts)
        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content: MAX_OUTPUT_TOKENS_RECOVERY_PROMPT,
            isMeta: true,
          })
          const nextAttempt = maxOutputTokensRecoveryCount + 1
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: nextAttempt,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: nextAttempt,
            },
          }
          continue
        }

        // 3. Recovery exhausted: surface withheld error
        yield lastMessage
      }

      if (lastMessage?.isApiErrorMessage) {
        return { reason: 'completed' }
      }

      // Snapshot CacheSafeParams for cache-sharing forked agents & trigger post-sampling hooks
      if (
        params.querySource === 'repl_main_thread' ||
        params.querySource === 'sdk'
      ) {
        const combinedMessages = [...messagesForQuery, ...assistantMessages]
        saveCacheSafeParams({
          systemPrompt: params.systemPrompt,
          userContext: params.userContext,
          systemContext: params.systemContext,
          toolUseContext,
          forkContextMessages: combinedMessages,
        })
        if (!isBareMode() && !toolUseContext.agentId) {
          void runPostSamplingHooks({
            messages: combinedMessages,
            systemPrompt: params.systemPrompt,
            userContext: params.userContext,
            systemContext: params.systemContext,
            toolUseContext: toolUseContext as FullToolUseContext,
            querySource: params.querySource,
          })
        }
      }

      // Stop hooks slot
      if (deps.handleStopHooks) {
        const stopHookResult = yield* deps.handleStopHooks(
          messagesForQuery,
          assistantMessages,
          params.systemPrompt,
          params.userContext,
          params.systemContext,
          toolUseContext,
          params.querySource,
          stopHookActive,
        )
        if (stopHookResult.preventContinuation) {
          return { reason: 'stop_hook_prevented' }
        }
        if (stopHookResult.blockingErrors.length > 0) {
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              ...stopHookResult.blockingErrors,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: true,
            turnCount,
            transition: { reason: 'stop_hook_blocking' },
          }
          continue
        }
      }

      // Token budget continuation check (<90% without diminishing returns)
      if (budgetTracker) {
        const agentId =
          typeof toolUseContext.agentId === 'string'
            ? toolUseContext.agentId
            : undefined
        const decision = checkTokenBudget(
          budgetTracker,
          agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )
        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount} (${decision.pct}%)`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }
        if (decision.completionEvent) {
          logEvent('tengu_token_budget_completed', {
            continuationCount: decision.completionEvent.continuationCount,
            pct: decision.completionEvent.pct,
            turnTokens: decision.completionEvent.turnTokens,
            budget: decision.completionEvent.budget,
            diminishingReturns: decision.completionEvent.diminishingReturns,
            durationMs: decision.completionEvent.durationMs,
          })
        }
      }

      return { reason: 'completed' }
    }

    // Tool execution slot
    queryCheckpoint('query_tool_execution_start')

    if (streamingExecutor) {
      for await (const update of streamingExecutor.getRemainingResults()) {
        if (update.message) {
          yield update.message
          if (
            update.message.type === 'attachment' &&
            update.message.attachment.type === 'hook_stopped_continuation'
          ) {
            shouldPreventContinuation = true
          }
          const normalized = normalizeMessagesForApi(
            [update.message],
            ctxOptions.tools,
          ).filter((m): m is UserMessage => m.type === 'user')
          toolResults.push(...normalized)
        }
        if (update.newContext) {
          updatedToolUseContext = { ...update.newContext, queryTracking }
        }
      }
      updatedToolUseContext = {
        ...streamingExecutor.getUpdatedContext(),
        queryTracking,
      }
    } else if (deps.runTools) {
      for await (const update of deps.runTools(
        toolUseBlocks,
        assistantMessages,
        params.canUseTool,
        toolUseContext,
      )) {
        if (update.message) {
          yield update.message
          if (
            update.message.type === 'attachment' &&
            update.message.attachment.type === 'hook_stopped_continuation'
          ) {
            shouldPreventContinuation = true
          }
          const normalized = normalizeMessagesForApi(
            [update.message],
            ctxOptions.tools,
          ).filter((m): m is UserMessage => m.type === 'user')
          toolResults.push(...normalized)
        }
        if (update.newContext) {
          updatedToolUseContext = { ...update.newContext, queryTracking }
        }
      }
    }

    queryCheckpoint('query_tool_execution_end')

    // Tool-phase abort check
    if (toolUseContext.abortController.signal.aborted) {
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({ toolUse: true })
      }
      const nextTurnCountOnAbort = turnCount + 1
      if (params.maxTurns && nextTurnCountOnAbort > params.maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns: params.maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnCounter: tracking.turnCounter,
      })
    }

    const updatedOptions = getContextOptions(updatedToolUseContext)
    if (updatedOptions.refreshTools) {
      const refreshed = updatedOptions.refreshTools()
      if (refreshed !== updatedOptions.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: { ...updatedOptions, tools: refreshed },
        }
      }
    }

    const nextTurnCount = turnCount + 1
    if (params.maxTurns && nextTurnCount > params.maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns: params.maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    if (!isBareMode()) {
      const combinedBeforeAttachments = [
        ...messagesForQuery,
        ...assistantMessages,
        ...toolResults,
      ]
      for await (const attMsg of getAttachmentMessages(
        null,
        updatedToolUseContext,
        undefined,
        [],
        combinedBeforeAttachments,
        params.querySource,
        { mainLoopModel: updatedOptions.mainLoopModel },
      )) {
        yield attMsg
        const normalizedAtt = normalizeMessagesForApi(
          [attMsg],
          updatedOptions.tools,
        ).filter((m): m is UserMessage => m.type === 'user')
        toolResults.push(...normalizedAtt)
      }
    }

    queryCheckpoint('query_recursive_call')
    state = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: { ...updatedToolUseContext, queryTracking },
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: undefined,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
  }
}

/**
 * Pure agentic turn state machine decoupled from UI and Headless shells.
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryEvent, Terminal> {
  return yield* queryLoop(params)
}
