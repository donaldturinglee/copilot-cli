/**
 * Headless / SDK session orchestrator (`QueryEngine` + one-shot `ask()`):
 * Manages `mutableMessages`, `readFileState`, `permissionDenials`, `totalUsage`,
 * `maxBudgetUsd`, and `maxTurns`, wrapping the pure `query()` generator into an
 * external `SdkMessage` stream.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import {
  getAdditionalDirectoriesForClaudeMd,
  getModelUsage,
  getSessionId,
  getTotalApiDuration,
  getTotalCostUsd,
  setAdditionalDirectoriesForClaudeMd,
  setCwdState,
} from './bootstrap/state.js'
import { getTotalCost } from './cost_tracker.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './constants/tools.js'
import { query } from './query.js'
import type { QueryDeps } from './query/deps.js'
import {
  accumulateUsage,
  EMPTY_USAGE,
  type NonNullableUsage,
  type PartialApiUsage,
  updateUsage,
} from './services/api/empty_usage.js'
import { categorizeRetryableApiError } from './services/api/errors.js'
import type { AppState } from './state/app_state_store.js'
import { asAnyTool } from './tool.js'
import { createSyntheticOutputTool } from './tools/synthetic_output_tool/synthetic_output_tool.js'
import type { Command } from './types/command.js'
import type {
  CanUseToolFn,
  McpServerConnection,
  Tool,
  ToolUseContext,
} from './types/forward.js'
import type { Message } from './types/message.js'
import { createAbortController } from './utilities/abort_controller.js'
import { randomUUID } from './utilities/crypto.js'
import { getFastModeState } from './utilities/fast_mode.js'
import { executeUserPromptSubmitHooks } from './utilities/hooks.js'
import { ensurePhase4HooksBootstrapped } from './utilities/hooks/bootstrap_hooks.js'
import {
  headlessProfilerCheckpoint,
  headlessProfilerStartTurn,
} from './utilities/headless_profiler.js'
import { getInMemoryErrors } from './utilities/log.js'
import {
  createUserMessage,
  getAssistantMessageText,
  SYNTHETIC_MESSAGES,
} from './utilities/messages.js'
import {
  type SdkMessage,
  type SdkModelUsageWire,
  type SdkPermissionDenial,
  type SdkResultMessage,
  toSdkCompactMetadata,
} from './utilities/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utilities/messages/system_init.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utilities/model/model.js'
import { fetchSystemPromptParts } from './utilities/query_context.js'
import {
  cloneFileStateCache,
  createFileStateCache,
  type FileStateCache,
  isResultSuccessful,
  normalizeMessage,
} from './utilities/query_helpers.js'
import { buildEffectiveSystemPrompt } from './utilities/system_prompt.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utilities/thinking.js'
import {
  type ContentReplacementState,
  createContentReplacementState,
} from './utilities/tool_result_storage.js'

const MAX_STRUCTURED_OUTPUT_RETRIES = 3

export interface QueryEngineAgentDefinition {
  agentType?: string
  name?: string
}

export interface QueryEngineConfig {
  cwd: string
  tools: readonly Tool[]
  commands: readonly Command[]
  mcpClients: readonly McpServerConnection[]
  agents?: readonly QueryEngineAgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache?: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  abortController?: AbortController
  additionalDirectories?: string[]
  deps?: QueryDeps
}

export interface SubmitMessageOptions {
  uuid?: UUID
  isMeta?: true
}

function toWireModelUsage(): Record<string, SdkModelUsageWire> {
  const internal = getModelUsage()
  const wire: Record<string, SdkModelUsageWire> = {}
  for (const [model, usage] of Object.entries(internal)) {
    wire[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUsd,
      contextWindow: usage.contextWindow,
      maxOutputTokens: usage.maxOutputTokens,
    }
  }
  return wire
}

/**
 * Stateful headless/SDK session controller managing conversation history,
 * per-session read cache, permission denials, USD budget, and turn caps.
 */
export class QueryEngine {
  private readonly config: QueryEngineConfig
  private mutableMessages: Message[]
  private readonly abortController: AbortController
  private readonly permissionDenials: SdkPermissionDenial[] = []
  private totalUsage: NonNullableUsage = { ...EMPTY_USAGE }
  private readFileState: FileStateCache
  private readonly contentReplacementState: ContentReplacementState =
    createContentReplacementState()
  private readonly discoveredSkillNames = new Set<string>()
  private readonly loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = [...(config.initialMessages ?? [])]
    this.abortController = config.abortController ?? createAbortController()
    this.readFileState = config.readFileCache ?? createFileStateCache()
  }

  /**
   * Aborts any currently executing turn.
   */
  interrupt(): void {
    this.abortController.abort()
  }

  /**
   * Returns an immutable view of accumulated conversation messages.
   */
  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  /**
   * Returns the session's `FileStateCache`.
   */
  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  /**
   * Returns the active session ID from process bootstrap state.
   */
  getSessionId(): string {
    return getSessionId()
  }

  /**
   * Updates the model override for subsequent turns.
   */
  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }

  /**
   * Submits a user prompt and streams `SdkMessage` wire events ending in a
   * `result` message (`success` or `error_*`).
   */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: SubmitMessageOptions,
  ): AsyncGenerator<SdkMessage, void> {
    ensurePhase4HooksBootstrapped()
    headlessProfilerStartTurn()
    this.discoveredSkillNames.clear()
    setCwdState(this.config.cwd)
    if (this.config.additionalDirectories?.length) {
      setAdditionalDirectoriesForClaudeMd(this.config.additionalDirectories)
    }

    const startTime = Date.now()
    const sessionId = getSessionId()

    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
    ) => {
      const result = await this.config.canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      )
      if (result.behavior !== 'allow') {
        const toolName =
          tool && typeof tool === 'object' && 'name' in tool
            ? String((tool as { name: unknown }).name)
            : 'unknown'
        this.permissionDenials.push({
          tool_name: sdkCompatToolName(toolName),
          tool_use_id: toolUseId,
          tool_input: input,
        })
      }
      return result
    }

    const mainLoopModel = this.config.userSpecifiedModel
      ? parseUserSpecifiedModel(this.config.userSpecifiedModel)
      : getMainLoopModel()

    const thinkingConfig: ThinkingConfig =
      this.config.thinkingConfig ??
      (shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' })

    const effectiveTools: readonly Tool[] = this.config.jsonSchema
      ? [
          ...this.config.tools.filter(
            t => t.name !== SYNTHETIC_OUTPUT_TOOL_NAME,
          ),
          asAnyTool(createSyntheticOutputTool(this.config.jsonSchema)),
        ]
      : this.config.tools

    const effectiveAppendSystemPrompt = this.config.jsonSchema
      ? [
          this.config.appendSystemPrompt,
          `You MUST return your final response by calling the \`${SYNTHETIC_OUTPUT_TOOL_NAME}\` tool with valid JSON conforming to the provided schema.`,
        ]
          .filter(Boolean)
          .join('\n\n')
      : this.config.appendSystemPrompt

    const appState = this.config.getAppState()
    const { defaultSystemPrompt, userContext, systemContext } =
      await fetchSystemPromptParts({
        tools: effectiveTools,
        mainLoopModel,
        additionalWorkingDirectories: getAdditionalDirectoriesForClaudeMd(),
        mcpClients: this.config.mcpClients,
        customSystemPrompt: this.config.customSystemPrompt,
      })

    const systemPrompt = buildEffectiveSystemPrompt({
      defaultSystemPrompt,
      customSystemPrompt: this.config.customSystemPrompt,
      appendSystemPrompt: effectiveAppendSystemPrompt,
    })

    const promptText =
      typeof prompt === 'string'
        ? prompt
        : prompt
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')

    const userPromptHookRes = await executeUserPromptSubmitHooks({
      prompt: promptText,
      permissionMode: appState.toolPermissionContext.mode,
      signal: this.abortController.signal,
    })

    if (
      userPromptHookRes.blockingErrors.length > 0 ||
      userPromptHookRes.preventContinuation
    ) {
      const errors =
        userPromptHookRes.blockingErrors.length > 0
          ? userPromptHookRes.blockingErrors.map(e => e.blockingError)
          : [userPromptHookRes.stopReason ?? 'Blocked by UserPromptSubmit hook']
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalApiDuration(),
        num_turns: 0,
        stop_reason: null,
        session_id: sessionId,
        total_cost_usd: getTotalCostUsd(),
        usage: { ...this.totalUsage },
        modelUsage: toWireModelUsage(),
        permission_denials: [...this.permissionDenials],
        fast_mode_state: getFastModeState(mainLoopModel, appState.fastMode),
        uuid: randomUUID(),
        errors,
      }
      return
    }

    const userMsg = createUserMessage({
      content: prompt,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
    })
    this.mutableMessages.push(userMsg)
    if (userPromptHookRes.additionalContexts.length > 0) {
      this.mutableMessages.push(
        createUserMessage({
          content: `<system-reminder>\n${userPromptHookRes.additionalContexts.join('\n')}\n</system-reminder>`,
          isMeta: true,
        }),
      )
    }
    const messages: Message[] = [...this.mutableMessages]

    const fastModeState = getFastModeState(mainLoopModel, appState.fastMode)

    yield buildSystemInitMessage({
      cwd: this.config.cwd,
      tools: effectiveTools,
      mcpClients: this.config.mcpClients,
      model: mainLoopModel,
      permissionMode: appState.toolPermissionContext.mode,
      commands: this.config.commands,
      agents: this.config.agents,
      plugins: appState.plugins.enabled,
      fastModeState,
    })
    headlessProfilerCheckpoint('system_message_yielded')

    if (this.config.replayUserMessages) {
      yield {
        type: 'user',
        message: userMsg.message,
        parent_tool_use_id: null,
        isReplay: true,
        uuid: userMsg.uuid,
        session_id: sessionId,
        timestamp: userMsg.timestamp,
      }
    }

    const toolUseContext: ToolUseContext = {
      abortController: this.abortController,
      messages,
      getAppState: this.config.getAppState,
      setAppState: this.config.setAppState,
      readFileState: this.readFileState,
      contentReplacementState: this.contentReplacementState,
      discoveredSkillNames: this.discoveredSkillNames,
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      options: {
        mainLoopModel,
        tools: effectiveTools,
        thinkingConfig,
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: Boolean(effectiveAppendSystemPrompt),
      },
    }

    let currentMessageUsage: NonNullableUsage = { ...EMPTY_USAGE }
    let sawStreamingUsage = false
    let turnCount = 1
    let lastStopReason: string | null = null
    let structuredOutputFromTool: unknown
    const errorLogWatermark = getInMemoryErrors().at(-1)

    const buildCommonResult = (numTurns: number) => ({
      type: 'result' as const,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalApiDuration(),
      num_turns: numTurns,
      stop_reason: lastStopReason,
      session_id: sessionId,
      total_cost_usd: getTotalCostUsd(),
      usage: { ...this.totalUsage },
      modelUsage: toWireModelUsage(),
      permission_denials: [...this.permissionDenials],
      fast_mode_state: getFastModeState(
        mainLoopModel,
        this.config.getAppState().fastMode,
      ),
      uuid: randomUUID(),
    })

    let structuredOutputAttempts = 0

    while (true) {
      for await (const event of query({
        messages,
        systemPrompt,
        userContext,
        systemContext,
        canUseTool: wrappedCanUseTool,
        toolUseContext,
        fallbackModel: this.config.fallbackModel,
        querySource: 'sdk',
        maxTurns: this.config.maxTurns,
        taskBudget: this.config.taskBudget,
        deps: this.config.deps,
      })) {
        if (
          event.type === 'assistant' ||
          event.type === 'user' ||
          (event.type === 'system' && event.subtype === 'compact_boundary')
        ) {
          messages.push(event)
        }
        if (event.type === 'user') {
          turnCount++
        }

        switch (event.type) {
          case 'tombstone':
          case 'stream_request_start':
            break

          case 'assistant': {
            if (event.message.stop_reason != null) {
              lastStopReason = event.message.stop_reason
            }
            if (!sawStreamingUsage && event.message.usage) {
              const assistantUsage = updateUsage(
                { ...EMPTY_USAGE },
                event.message.usage as unknown as PartialApiUsage,
              )
              this.totalUsage = accumulateUsage(
                this.totalUsage,
                assistantUsage,
              )
            }
            this.mutableMessages.push(event)
            yield* normalizeMessage(event)
            break
          }

          case 'user':
          case 'progress': {
            this.mutableMessages.push(event)
            yield* normalizeMessage(event)
            break
          }

          case 'stream_event': {
            sawStreamingUsage = true
            const rawEvent = event.event
            if (rawEvent.type === 'message_start') {
              currentMessageUsage = updateUsage(
                { ...EMPTY_USAGE },
                rawEvent.message.usage as unknown as PartialApiUsage,
              )
            } else if (rawEvent.type === 'message_delta') {
              currentMessageUsage = updateUsage(
                currentMessageUsage,
                rawEvent.usage as unknown as PartialApiUsage,
              )
              if (rawEvent.delta.stop_reason != null) {
                lastStopReason = rawEvent.delta.stop_reason
              }
            } else if (rawEvent.type === 'message_stop') {
              this.totalUsage = accumulateUsage(
                this.totalUsage,
                currentMessageUsage,
              )
            }
            if (this.config.includePartialMessages) {
              yield {
                type: 'stream_event',
                event: rawEvent,
                parent_tool_use_id: null,
                uuid: randomUUID(),
                session_id: sessionId,
              }
            }
            break
          }

          case 'attachment': {
            this.mutableMessages.push(event)
            messages.push(event)
            if (event.attachment.type === 'structured_output') {
              structuredOutputFromTool = event.attachment.data
            } else if (event.attachment.type === 'max_turns_reached') {
              const maxTurns = Number(
                event.attachment.maxTurns ?? this.config.maxTurns ?? 0,
              )
              const reachedTurns = Number(
                event.attachment.turnCount ?? turnCount,
              )
              const resultMsg: SdkResultMessage = {
                ...buildCommonResult(reachedTurns),
                subtype: 'error_max_turns',
                is_error: true,
                errors: [`Reached maximum number of turns (${maxTurns})`],
              }
              yield resultMsg
              return
            }
            break
          }

          case 'system': {
            this.mutableMessages.push(event)
            if (event.subtype === 'compact_boundary' && event.compactMetadata) {
              const boundaryIdx = this.mutableMessages.lastIndexOf(event)
              if (boundaryIdx > 0) {
                this.mutableMessages.splice(0, boundaryIdx)
              }
              const msgBoundaryIdx = messages.lastIndexOf(event)
              if (msgBoundaryIdx > 0) {
                messages.splice(0, msgBoundaryIdx)
              }
              yield {
                type: 'system',
                subtype: 'compact_boundary',
                compact_metadata: toSdkCompactMetadata(event.compactMetadata),
                uuid: event.uuid,
                session_id: sessionId,
              }
            } else if (event.subtype === 'api_error') {
              yield {
                type: 'system',
                subtype: 'api_retry',
                attempt: event.retryAttempt,
                max_retries: event.maxRetries,
                retry_delay_ms: event.retryInMs,
                error_status: event.error.status ?? null,
                error: categorizeRetryableApiError(event.error),
                uuid: event.uuid,
                session_id: sessionId,
              }
            }
            break
          }

          case 'tool_use_summary': {
            yield {
              type: 'tool_use_summary',
              summary: event.summary,
              preceding_tool_use_ids: event.precedingToolUseIds,
              uuid: event.uuid,
              session_id: sessionId,
            }
            break
          }

          default:
            break
        }

        // Enforce USD budget ceiling after each yielded event
        if (
          this.config.maxBudgetUsd !== undefined &&
          getTotalCost() >= this.config.maxBudgetUsd
        ) {
          const budgetResult: SdkResultMessage = {
            ...buildCommonResult(turnCount),
            subtype: 'error_max_budget_usd',
            is_error: true,
            errors: [`Reached maximum budget ($${this.config.maxBudgetUsd})`],
          }
          yield budgetResult
          return
        }
      }

      if (
        !this.config.jsonSchema ||
        structuredOutputFromTool !== undefined ||
        this.abortController.signal.aborted
      ) {
        break
      }

      structuredOutputAttempts++
      if (structuredOutputAttempts > MAX_STRUCTURED_OUTPUT_RETRIES) {
        const failedResult: SdkResultMessage = {
          ...buildCommonResult(turnCount),
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          errors: [
            `Failed to provide valid structured output after ${MAX_STRUCTURED_OUTPUT_RETRIES} retries`,
          ],
        }
        yield failedResult
        return
      }

      const retryPrompt = createUserMessage({
        content: `You must call the \`${SYNTHETIC_OUTPUT_TOOL_NAME}\` tool with valid JSON matching the required schema.`,
        isMeta: true,
      })
      this.mutableMessages.push(retryPrompt)
      messages.push(retryPrompt)
    }

    // Assemble final result
    let lastConversationMsg: Message | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && (m.type === 'assistant' || m.type === 'user')) {
        lastConversationMsg = m
        break
      }
    }

    if (
      !lastConversationMsg ||
      !isResultSuccessful(lastConversationMsg, lastStopReason)
    ) {
      const allErrors = getInMemoryErrors()
      const watermarkIdx = errorLogWatermark
        ? allErrors.lastIndexOf(errorLogWatermark)
        : -1
      const turnErrors = allErrors
        .slice(watermarkIdx + 1)
        .map(entry => entry.error)

      const edeResultType = lastConversationMsg?.type ?? 'none'
      const edeLastContentType =
        lastConversationMsg?.type === 'assistant'
          ? (lastConversationMsg.message.content.at(-1)?.type ?? 'empty')
          : 'none'

      const errorResult: SdkResultMessage = {
        ...buildCommonResult(turnCount),
        subtype: 'error_during_execution',
        is_error: true,
        errors: [
          `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${String(lastStopReason)}`,
          ...turnErrors,
        ],
      }
      yield errorResult
      return
    }

    let resultText = ''
    let isApiError = false
    if (lastConversationMsg.type === 'assistant') {
      isApiError = Boolean(lastConversationMsg.isApiErrorMessage)
      const text = getAssistantMessageText(lastConversationMsg)
      resultText = SYNTHETIC_MESSAGES.has(text) ? '' : text
    }

    const successResult: SdkResultMessage = {
      ...buildCommonResult(turnCount),
      subtype: 'success',
      is_error: isApiError,
      result: resultText,
      ...(structuredOutputFromTool !== undefined
        ? { structured_output: structuredOutputFromTool }
        : {}),
    }
    yield successResult
  }
}

let sharedReadFileCache: FileStateCache = createFileStateCache()

/**
 * One-shot convenience wrapper constructing a `QueryEngine` for a single prompt.
 */
export async function* ask(
  prompt: string | ContentBlockParam[],
  config: Omit<QueryEngineConfig, 'readFileCache'> & {
    readFileCache?: FileStateCache
  },
): AsyncGenerator<SdkMessage, void> {
  const engine = new QueryEngine({
    ...config,
    readFileCache:
      config.readFileCache ?? cloneFileStateCache(sharedReadFileCache),
  })
  try {
    yield* engine.submitMessage(prompt)
  } finally {
    sharedReadFileCache = engine.getReadFileState()
  }
}
