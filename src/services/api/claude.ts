/**
 * Core LLM API transport (`queryModelWithStreaming`, `queryModelWithoutStreaming`,
 * `queryHaiku`, `queryWithModel`, `verifyApiKey`):
 * - Consumes raw SSE streams directly (`beta.messages.create({ stream: true }).withResponse()`)
 *   yielding a separate `AssistantMessage` on each `content_block_stop` and
 *   patching `usage` / `stop_reason` in place on `message_delta`.
 * - 90s stream idle watchdog, 30s stall detection, empty-stream detection, and
 *   non-streaming fallback (`<= 64,000` tokens + `onStreamingFallback` tombstone hook).
 * - Prompt Cache breakpoint placement (`global`/`org` system prompt split +
 *   single tail breakpoint on messages + `skipCacheWrite` fork optimization).
 * - 2-stage prompt cache break detection and media item cap (`100`).
 */

import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaTextBlockParam,
  BetaToolChoice,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setFastModeHeaderLatched,
  setLastApiRequest,
  setLastApiRequestMessages,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
  setThinkingClearLatched,
} from '../../bootstrap/state.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/api_limits.js'
import {
  ADVISOR_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  getAfkModeBetaHeader,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from '../../constants/betas.js'
import type { QuerySource } from '../../constants/query_source.js'
import {
  getAttributionHeader,
  getCliSyspromptPrefix,
} from '../../constants/system.js'
import { addToTotalSessionCost } from '../../cost_tracker.js'
import type { Tool } from '../../types/forward.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemApiErrorMessage,
  UserMessage,
} from '../../types/message.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { ADVISOR_TOOL_INSTRUCTIONS } from '../../utilities/advisor.js'
import {
  splitSysPromptPrefix,
  toolToApiSchema,
  type CacheScope,
} from '../../utilities/api.js'
import {
  getOauthAccountInfo,
  isClaudeAiSubscriber,
} from '../../utilities/auth.js'
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
  getModelBetas,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from '../../utilities/betas.js'
import { getOrCreateUserId } from '../../utilities/config.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getMaxThinkingTokensForModel,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
} from '../../utilities/context.js'
import { randomUUID } from '../../utilities/crypto.js'
import { logForDebugging } from '../../utilities/debug.js'
import { resolveAppliedEffort, type EffortValue } from '../../utilities/effort.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import { validateBoundedIntEnvVar } from '../../utilities/env_validation.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utilities/fast_mode.js'
import { isFeatureEnabled } from '../../utilities/feature_flags.js'
import { computeFingerprintFromMessages } from '../../utilities/fingerprint.js'
import { safeParseJson } from '../../utilities/json.js'
import {
  createAssistantApiErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromApi,
  normalizeMessagesForApi,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utilities/messages.js'
import { getInferenceProfileBackingModel } from '../../utilities/model/bedrock.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  isNonCustomOpusModel,
  normalizeModelStringForApi,
} from '../../utilities/model/model.js'
import { getApiProvider } from '../../utilities/model/providers.js'
import { calculateUsdCost } from '../../utilities/model_cost.js'
import { jsonStringify } from '../../utilities/slow_operations.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utilities/system_prompt_type.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from '../../utilities/thinking.js'
import { getFeatureValueCachedMayBeStale } from '../analytics/growthbook.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../analytics/index.js'
import {
  extractQuotaStatusFromHeaders,
  getCurrentLimits,
} from '../claude_ai_limits.js'
import { withStreamingVcr, withVcr } from '../vcr.js'
import { getAnthropicClient } from './client.js'
import {
  accumulateUsage,
  EMPTY_USAGE,
  type NonNullableUsage,
  type PartialApiUsage,
  updateUsage,
} from './empty_usage.js'
import {
  classifyApiError,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  type GlobalCacheStrategy,
  logApiError,
  logApiQuery,
  logApiSuccessAndDuration,
} from './logging.js'
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './prompt_cache_break_detection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './with_retry.js'

export { accumulateUsage, updateUsage }

export const MAX_NON_STREAMING_TOKENS = 64_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000
const STALL_THRESHOLD_MS = 30_000

export interface JsonOutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

export interface QueryModelOptions {
  model: string
  getToolPermissionContext?: () =>
    | Promise<ToolPermissionContext | DeepImmutable<ToolPermissionContext>>
    | ToolPermissionContext
    | DeepImmutable<ToolPermissionContext>
  fastMode?: boolean
  toolChoice?: BetaToolChoice
  isNonInteractiveSession?: boolean
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource?: QuerySource
  hasAppendSystemPrompt?: boolean
  maxOutputTokensOverride?: number
  temperatureOverride?: number
  enablePromptCaching?: boolean
  outputFormat?: JsonOutputFormat
  fetchOverride?: typeof fetch
  effortValue?: EffortValue
  advisorModel?: string
  skipCacheWrite?: boolean
  agentId?: string
  taskBudget?: { total: number; remaining?: number }
  maxRetries?: number
  /** Test-only client factory override to mock SSE/non-streaming transports. */
  clientFactoryOverride?: () => Promise<Anthropic>
}

export interface QueryModelParams {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: readonly Tool[]
  signal: AbortSignal
  options: QueryModelOptions
}

interface CacheControlParam {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
}

interface RawStreamLike<EventType = BetaRawMessageStreamEvent>
  extends AsyncIterable<EventType> {
  controller?: AbortController
}

/**
 * Safely aborts an Anthropic SDK SSE stream controller to free underlying sockets.
 */
export function cleanupStream(stream?: RawStreamLike | null): void {
  if (!stream?.controller) {
    return
  }
  if (!stream.controller.signal.aborted) {
    try {
      stream.controller.abort()
    } catch {
      // Ignore abort errors during cleanup
    }
  }
}

/**
 * Returns whether prompt caching is enabled for `model`.
 */
export function getPromptCachingEnabled(model: string): boolean {
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) {
    return false
  }
  if (
    isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU) &&
    model === getSmallFastModel()
  ) {
    return false
  }
  if (
    isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET) &&
    model === getDefaultSonnetModel()
  ) {
    return false
  }
  if (
    isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS) &&
    model === getDefaultOpusModel()
  ) {
    return false
  }
  return true
}

function should1hCacheTtl(querySource?: QuerySource): boolean {
  if (
    getApiProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  let eligible = getPromptCache1hEligible()
  if (eligible === null) {
    eligible =
      process.env.USER_TYPE === 'ant' ||
      (isClaudeAiSubscriber() && !getCurrentLimits().isUsingOverage)
    setPromptCache1hEligible(eligible)
  }
  if (!eligible || !querySource) {
    return false
  }

  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const cfg = getFeatureValueCachedMayBeStale<{ allowlist?: string[] }>(
      'tengu_prompt_cache_1h_config',
      {},
    )
    allowlist = Array.isArray(cfg.allowlist) ? cfg.allowlist : []
    setPromptCache1hAllowlist(allowlist)
  }

  return allowlist.some(pattern => {
    if (pattern.endsWith('*')) {
      return querySource.startsWith(pattern.slice(0, -1))
    }
    return querySource === pattern
  })
}

/**
 * Builds the `cache_control` marker object (only serializes `scope: 'global'`;
 * `'org'` is represented by omitting `scope`).
 */
export function getCacheControl(options?: {
  scope?: CacheScope
  querySource?: QuerySource
}): CacheControlParam {
  return {
    type: 'ephemeral',
    ...(should1hCacheTtl(options?.querySource) ? { ttl: '1h' } : {}),
    ...(options?.scope === 'global' ? { scope: 'global' } : {}),
  }
}

/**
 * Converts a finalized system prompt into Anthropic API `TextBlockParam[]` with
 * prompt-cache breakpoints on eligible `global` or `org` blocks.
 */
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt | readonly string[],
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): BetaTextBlockParam[] {
  const split = splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  })
  return split.map(block => {
    const textBlock: BetaTextBlockParam = {
      type: 'text',
      text: block.text,
    }
    if (enablePromptCaching && block.cacheScope !== null) {
      ;(textBlock as unknown as Record<string, unknown>).cache_control =
        getCacheControl({
          scope: block.cacheScope,
          querySource: options?.querySource,
        })
    }
    return textBlock
  })
}

/**
 * Converts an internal `UserMessage` to an API `MessageParam`, optionally
 * attaching a `cache_control` breakpoint on its last content block.
 */
export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching = true,
  querySource?: QuerySource,
): MessageParam {
  const shouldCache = addCache && enablePromptCaching
  const content = message.message.content

  if (typeof content === 'string') {
    if (!shouldCache) {
      return { role: 'user', content }
    }
    return {
      role: 'user',
      content: [
        {
          type: 'text',
          text: content,
          cache_control: getCacheControl({ querySource }) as {
            type: 'ephemeral'
          },
        },
      ],
    }
  }

  // Shallow-clone array to avoid downstream splice mutation contamination
  const cloned = content.map((block, index) => {
    if (shouldCache && index === content.length - 1) {
      return {
        ...block,
        cache_control: getCacheControl({ querySource }) as {
          type: 'ephemeral'
        },
      }
    }
    return block
  })

  return {
    role: 'user',
    content: cloned,
  }
}

/**
 * Converts an internal `AssistantMessage` to an API `MessageParam`, attaching
 * `cache_control` only to non-thinking trailing blocks when `addCache` is true.
 */
export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching = true,
  querySource?: QuerySource,
): MessageParam {
  const shouldCache = addCache && enablePromptCaching
  const content = message.message.content

  const cloned = content.map((block, index) => {
    const isLast = index === content.length - 1
    const blockType = (block as { type: string }).type
    const canAttachCache =
      shouldCache &&
      isLast &&
      blockType !== 'thinking' &&
      blockType !== 'redacted_thinking' &&
      blockType !== 'connector_text'
    if (canAttachCache) {
      return {
        ...block,
        cache_control: getCacheControl({ querySource }) as {
          type: 'ephemeral'
        },
      }
    }
    return block
  })

  return {
    role: 'assistant',
    content: cloned as unknown as MessageParam['content'],
  }
}

/**
 * Places a single tail prompt-cache breakpoint on `messages`:
 * - Normal requests: `messages.length - 1`
 * - Forked cache-preserving requests (`skipCacheWrite: true`): `messages.length - 2`
 */
export function addCacheBreakpoints(
  messages: ReadonlyArray<UserMessage | AssistantMessage>,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  skipCacheWrite = false,
): MessageParam[] {
  const markerIndex = skipCacheWrite
    ? messages.length - 2
    : messages.length - 1

  return messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })
}

/**
 * Enforces the Anthropic API media cap (`limit = 100`), stripping oldest
 * `image` and `document` blocks (including nested inside `tool_result.content`).
 */
export function stripExcessMediaItems(
  messages: ReadonlyArray<UserMessage | AssistantMessage>,
  limit = API_MAX_MEDIA_PER_REQUEST,
): Array<UserMessage | AssistantMessage> {
  const isMedia = (block: unknown): boolean => {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      return false
    }
    const type = (block as { type?: unknown }).type
    return type === 'image' || type === 'document'
  }

  let totalMedia = 0
  for (const msg of messages) {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) {
        totalMedia++
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) totalMedia++
        }
      }
    }
  }

  let toRemove = totalMedia - limit
  if (toRemove <= 0) {
    return [...messages]
  }

  return messages.map(msg => {
    if (toRemove <= 0 || msg.type !== 'user' || !Array.isArray(msg.message.content)) {
      return msg
    }
    const nextContent = []
    for (const block of msg.message.content) {
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const keptNested = []
        for (const nested of block.content) {
          if (toRemove > 0 && isMedia(nested)) {
            toRemove--
            continue
          }
          keptNested.push(nested)
        }
        nextContent.push({
          ...block,
          content:
            keptNested.length > 0
              ? keptNested
              : [{ type: 'text' as const, text: '[Media omitted due to limit]' }],
        })
      } else if (toRemove > 0 && isMedia(block)) {
        toRemove--
      } else {
        nextContent.push(block)
      }
    }
    return {
      ...msg,
      message: {
        role: 'user',
        content:
          nextContent.length > 0
            ? nextContent
            : [{ type: 'text' as const, text: '[Media omitted due to limit]' }],
      },
    }
  })
}

/**
 * Resolves the effective `max_tokens` for `model`, respecting the GrowthBook
 * `tengu_otk_slot_v1` default cap and `COPILOT_CLI_MAX_OUTPUT_TOKENS`.
 */
export function getMaxOutputTokensForModel(model: string): number {
  const bounds = getModelMaxOutputTokens(model)
  const capDefault = getFeatureValueCachedMayBeStale('tengu_otk_slot_v1', false)
  const defaultTokens = capDefault
    ? Math.min(bounds.default, CAPPED_DEFAULT_MAX_TOKENS)
    : bounds.default
  return validateBoundedIntEnvVar(
    'COPILOT_CLI_MAX_OUTPUT_TOKENS',
    process.env.COPILOT_CLI_MAX_OUTPUT_TOKENS,
    defaultTokens,
    bounds.upperLimit,
  ).effective
}

/**
 * Clamps `max_tokens` (and `thinking.budget_tokens` if enabled) for non-streaming
 * fallback requests (`maxTokensCap = 64_000`).
 */
export function adjustParamsForNonStreaming<
  Params extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: Params, maxTokensCap = MAX_NON_STREAMING_TOKENS): Params {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)
  let thinking = params.thinking
  if (
    thinking &&
    thinking.type === 'enabled' &&
    typeof thinking.budget_tokens === 'number'
  ) {
    thinking = {
      ...thinking,
      budget_tokens: Math.min(thinking.budget_tokens, cappedMaxTokens - 1),
    }
  }
  return {
    ...params,
    max_tokens: cappedMaxTokens,
    ...(thinking !== undefined ? { thinking } : {}),
  }
}

/**
 * Parses `COPILOT_CLI_EXTRA_BODY` JSON and merges Bedrock `anthropic_beta` extras.
 */
export function getExtraBodyParams(
  betaHeaders?: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const raw = process.env.COPILOT_CLI_EXTRA_BODY
  if (raw) {
    const parsed = safeParseJson(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(result, parsed as Record<string, unknown>)
    }
  }
  if (betaHeaders && betaHeaders.length > 0) {
    const existing = Array.isArray(result.anthropic_beta)
      ? (result.anthropic_beta as string[])
      : []
    result.anthropic_beta = Array.from(new Set([...existing, ...betaHeaders]))
  }
  return result
}

/**
 * Configures API `task_budget` parameters in `outputConfig` and appends the
 * required beta header (1P only).
 */
export function configureTaskBudgetParams(
  taskBudget: { total: number; remaining?: number } | undefined,
  outputConfig: Record<string, unknown>,
  betas: string[],
): void {
  if (!taskBudget || getApiProvider() !== 'firstParty') {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined
      ? { remaining: taskBudget.remaining }
      : {}),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

/**
 * Builds `metadata: { user_id: JSON }` payload for Anthropic API telemetry.
 */
export function getApiMetadata(): { user_id: string } {
  let extra: Record<string, unknown> = {}
  if (process.env.COPILOT_CLI_EXTRA_METADATA) {
    const parsed = safeParseJson(process.env.COPILOT_CLI_EXTRA_METADATA)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as Record<string, unknown>
    }
  }
  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserId(),
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

function getStreamIdleTimeoutMs(): number {
  const raw = process.env.COPILOT_CLI_STREAM_IDLE_TIMEOUT_MS
  if (raw) {
    const parsed = Number(raw)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

function isStreamWatchdogEnabled(): boolean {
  // Enabled by default if COPILOT_CLI_ENABLE_STREAM_WATCHDOG is truthy or unset in non-disabled mode
  if (process.env.COPILOT_CLI_ENABLE_STREAM_WATCHDOG !== undefined) {
    return isEnvTruthy(process.env.COPILOT_CLI_ENABLE_STREAM_WATCHDOG)
  }
  return true
}

function isNonStreamingFallbackDisabled(): boolean {
  return (
    isEnvTruthy(process.env.COPILOT_CLI_DISABLE_NONSTREAMING_FALLBACK) ||
    getFeatureValueCachedMayBeStale(
      'tengu_disable_streaming_to_non_streaming_fallback',
      false,
    )
  )
}

/**
 * Executes a non-streaming `beta.messages.create({ stream: false })` request
 * capped at `MAX_NON_STREAMING_TOKENS` (64k), yielding any retry system errors.
 */
export async function* executeNonStreamingRequest(
  getClient: () => Promise<Anthropic>,
  retryOptions: {
    maxRetries?: number
    model: string
    thinkingConfig: ThinkingConfig
    fallbackModel?: string
    fastMode?: boolean
    signal?: AbortSignal
    querySource?: QuerySource
    initialConsecutive529Errors?: number
  },
  paramsFromContext: (retryContext: RetryContext) => BetaMessageStreamParams,
  onAttempt?: () => void,
): AsyncGenerator<SystemApiErrorMessage, { data: BetaMessage; requestId?: string; headers?: Headers }> {
  const result = yield* withRetry(
    getClient,
    async (client, _attempt, retryContext) => {
      onAttempt?.()
      const baseParams = paramsFromContext(retryContext)
      const adjusted = adjustParamsForNonStreaming(
        baseParams,
        MAX_NON_STREAMING_TOKENS,
      )
      const response = await client.beta.messages
        .create(
          {
            ...adjusted,
            stream: false,
          } as Parameters<typeof client.beta.messages.create>[0],
          { signal: retryOptions.signal },
        )
        .withResponse()
      return {
        data: response.data as BetaMessage,
        requestId: response.request_id ?? undefined,
        headers: response.response?.headers,
      }
    },
    retryOptions,
  )
  return result
}

async function* queryModelInner({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: QueryModelParams): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemApiErrorMessage,
  void
> {
  const overallStart = Date.now()
  let attemptStart = overallStart

  // Opus capacity off-switch check for non-subscribers
  if (
    !isClaudeAiSubscriber() &&
    isNonCustomOpusModel(options.model) &&
    getFeatureValueCachedMayBeStale<{ activated?: boolean }>(
      'tengu-off-switch',
      {},
    ).activated
  ) {
    yield createAssistantApiErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'server_error',
    })
    return
  }

  let resolvedModel = options.model
  if (getApiProvider() === 'bedrock') {
    const backing = await getInferenceProfileBackingModel(options.model)
    if (backing) {
      resolvedModel = backing
    }
  }

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const isAgenticQuery =
    !options.querySource ||
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource === 'sdk' ||
    options.querySource.startsWith('agent:')

  // Build base beta header set
  const baseBetas = [...getMergedBetas(options.model, { isAgenticQuery })]

  if (options.advisorModel && !baseBetas.includes(ADVISOR_BETA_HEADER)) {
    baseBetas.push(ADVISOR_BETA_HEADER)
  }
  if (
    getSonnet1mExpTreatmentEnabled(options.model) &&
    !baseBetas.includes(CONTEXT_1M_BETA_HEADER)
  ) {
    baseBetas.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    options.outputFormat &&
    modelSupportsStructuredOutputs(options.model) &&
    !baseBetas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    baseBetas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Sticky beta latches (prevent mid-session cache invalidation)
  const afkBeta = getAfkModeBetaHeader()
  if (
    afkBeta &&
    isAgenticQuery &&
    shouldIncludeFirstPartyOnlyBetas() &&
    getAfkModeHeaderLatched() === true &&
    !baseBetas.includes(afkBeta)
  ) {
    baseBetas.push(afkBeta)
  }

  const wantFastMode = Boolean(
    options.fastMode &&
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      isFastModeSupportedByModel(options.model),
  )
  if (wantFastMode && getFastModeHeaderLatched() !== true) {
    setFastModeHeaderLatched(true)
  }
  if (
    getFastModeHeaderLatched() === true &&
    !baseBetas.includes(FAST_MODE_BETA_HEADER)
  ) {
    baseBetas.push(FAST_MODE_BETA_HEADER)
  }

  const lastCompletion = getLastApiCompletionTimestamp()
  if (
    isAgenticQuery &&
    lastCompletion !== null &&
    Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS &&
    getThinkingClearLatched() !== true
  ) {
    setThinkingClearLatched(true)
  }

  // Latch placeholders referenced so TypeScript retains latch helpers in DAG
  void setAfkModeHeaderLatched
  void setCacheEditingHeaderLatched
  void getCacheEditingHeaderLatched

  const toolSchemas = await Promise.all(
    tools.map(tool => toolToApiSchema(tool)),
  )
  const extraToolSchemas: Array<Record<string, unknown>> = []
  if (options.advisorModel) {
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: options.advisorModel,
    })
  }
  const allTools = [...toolSchemas, ...extraToolSchemas]

  // Message normalization pipeline (strict order)
  let messagesForApi = normalizeMessagesForApi(messages, tools)
  messagesForApi = messagesForApi.map(msg =>
    msg.type === 'user'
      ? stripToolReferenceBlocksFromUserMessage(msg)
      : stripCallerFieldFromAssistantMessage(msg),
  )
  messagesForApi = ensureToolResultPairing(messagesForApi)
  if (!baseBetas.includes(ADVISOR_BETA_HEADER)) {
    messagesForApi = stripAdvisorBlocks(messagesForApi)
  }
  messagesForApi = stripExcessMediaItems(messagesForApi, API_MAX_MEDIA_PER_REQUEST)

  const fingerprint = computeFingerprintFromMessages(messagesForApi)
  const attributionHeader = getAttributionHeader(fingerprint)
  const cliPrefix = getCliSyspromptPrefix({
    isNonInteractive: Boolean(options.isNonInteractiveSession),
    hasAppendSystemPrompt: Boolean(options.hasAppendSystemPrompt),
  })

  const finalizedSystemPrompt = asSystemPrompt(
    [
      attributionHeader,
      cliPrefix,
      ...systemPrompt,
      ...(options.advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  const hasNonDeferredMcpTool = tools.some(
    t => t.isMcp === true && t.shouldDefer !== true,
  )
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? hasNonDeferredMcpTool
      ? 'none'
      : 'system_prompt'
    : 'none'

  if (
    useGlobalCacheFeature &&
    !baseBetas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    baseBetas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  const bedrockExtraBetas = getBedrockExtraBodyParamsBetas(options.model)

  const paramsFromContext = (
    retryContext: RetryContext,
  ): BetaMessageStreamParams => {
    const betasParams = [...baseBetas]
    const maxOutputTokens =
      retryContext.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const outputConfig: Record<string, unknown> = {}
    const appliedEffort = resolveAppliedEffort(
      options.model,
      options.effortValue,
    )
    if (typeof appliedEffort === 'string') {
      outputConfig.effort = appliedEffort
      if (!betasParams.includes(EFFORT_BETA_HEADER)) {
        betasParams.push(EFFORT_BETA_HEADER)
      }
    }
    configureTaskBudgetParams(options.taskBudget, outputConfig, betasParams)
    if (options.outputFormat) {
      outputConfig.format = options.outputFormat
    }

    const extraBodyParams = getExtraBodyParams(bedrockExtraBetas)
    if (
      typeof appliedEffort === 'number' &&
      process.env.USER_TYPE === 'ant'
    ) {
      extraBodyParams.anthropic_internal = {
        ...((extraBodyParams.anthropic_internal as
          | Record<string, unknown>
          | undefined) ?? {}),
        effort_override: appliedEffort,
      }
    }

    const disableThinking = isEnvTruthy(
      process.env.COPILOT_CLI_DISABLE_THINKING,
    )
    let thinkingParam: BetaMessageStreamParams['thinking']
    if (
      !disableThinking &&
      thinkingConfig.type !== 'disabled' &&
      modelSupportsThinking(options.model)
    ) {
      if (
        !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_ADAPTIVE_THINKING) &&
        thinkingConfig.type === 'adaptive' &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        thinkingParam = {
          type: 'adaptive',
        } as unknown as BetaMessageStreamParams['thinking']
      } else {
        const budget =
          thinkingConfig.type === 'enabled'
            ? thinkingConfig.budgetTokens
            : getMaxThinkingTokensForModel(options.model)
        thinkingParam = {
          type: 'enabled',
          budget_tokens: Math.min(Math.max(1024, maxOutputTokens - 1), budget),
        }
      }
    }

    const systemBlocks = buildSystemPromptBlocks(
      finalizedSystemPrompt,
      enablePromptCaching,
      {
        skipGlobalCacheForSystemPrompt: hasNonDeferredMcpTool,
        querySource: options.querySource,
      },
    )

    const apiMessages = addCacheBreakpoints(
      messagesForApi,
      enablePromptCaching,
      options.querySource,
      Boolean(options.skipCacheWrite),
    )

    const fastModeActiveNow =
      Boolean(retryContext.fastMode) &&
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model)

    const params: Record<string, unknown> = {
      model: normalizeModelStringForApi(options.model),
      messages: apiMessages as BetaMessageParam[],
      system: systemBlocks,
      max_tokens: maxOutputTokens,
      metadata: getApiMetadata(),
      ...(allTools.length > 0 ? { tools: allTools as unknown as BetaToolUnion[] } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      ...(betasParams.length > 0 ? { betas: betasParams } : {}),
      ...(thinkingParam ? { thinking: thinkingParam } : {}),
      ...(!thinkingParam
        ? { temperature: options.temperatureOverride ?? 1 }
        : {}),
      ...(Object.keys(outputConfig).length > 0
        ? { output_config: outputConfig }
        : {}),
      ...(fastModeActiveNow ? { speed: 'fast' } : {}),
      ...extraBodyParams,
    }

    return params as unknown as BetaMessageStreamParams
  }

  const getClient =
    options.clientFactoryOverride ??
    (() =>
      getAnthropicClient({
        maxRetries: 0,
        model: options.model,
        fetchOverride: options.fetchOverride,
        source: options.querySource,
      }))

  const previewParams = paramsFromContext({
    model: options.model,
    thinkingConfig,
    fastMode: options.fastMode,
  })
  const { messages: previewMessages, ...previewRest } = previewParams
  setLastApiRequest(previewRest)
  setLastApiRequestMessages(previewMessages)

  if (isFeatureEnabled('PROMPT_CACHE_BREAK_DETECTION')) {
    recordPromptState({
      querySource: options.querySource,
      agentId: options.agentId,
      model: options.model,
      system: Array.isArray(previewParams.system)
        ? (previewParams.system as unknown as ReadonlyArray<
            Record<string, unknown>
          >)
        : [],
      toolSchemas: allTools as unknown as ReadonlyArray<
        Record<string, unknown>
      >,
      betas: (previewParams.betas as string[] | undefined) ?? [],
      fastMode: getFastModeHeaderLatched() === true,
      globalCacheStrategy,
      autoModeActive: getAfkModeHeaderLatched() === true,
      isUsingOverage: Boolean(getCurrentLimits().isUsingOverage),
      effortValue: resolveAppliedEffort(options.model, options.effortValue),
      extraBodyParams: getExtraBodyParams(bedrockExtraBetas),
    })
  }

  logApiQuery({
    model: options.model,
    messagesLength: messagesForApi.length,
    temperature: previewParams.temperature,
    betas: previewParams.betas as string[] | undefined,
    querySource: options.querySource,
    globalCacheStrategy,
    agentId: options.agentId,
  })

  let didFallBackToNonStreaming = false
  let streamRequestId: string | undefined
  let responseHeaders: Headers | null = null
  let usage: NonNullableUsage = { ...EMPTY_USAGE }
  let stopReason: BetaStopReason | null = null
  let ttftMs = 0
  let totalCostUsd = 0

  const runFallback = async function* (
    initialConsecutive529Errors: number,
  ): AsyncGenerator<StreamEvent | AssistantMessage | SystemApiErrorMessage, void> {
    didFallBackToNonStreaming = true
    options.onStreamingFallback?.()
    logEvent('tengu_nonstreaming_fallback_started', {
      model: options.model as VerifiedNonSensitiveAnalyticsMetadata,
    })

    let fallbackMessage: AssistantMessage | null = null
    let fallbackUsage: PartialApiUsage | null = null
    try {
      const result = yield* executeNonStreamingRequest(
        getClient,
        {
          maxRetries: options.maxRetries,
          model: options.model,
          thinkingConfig,
          fallbackModel: options.fallbackModel,
          fastMode: options.fastMode,
          signal,
          querySource: options.querySource,
          initialConsecutive529Errors,
        },
        paramsFromContext,
        () => {
          attemptStart = Date.now()
        },
      )

      streamRequestId = result.requestId
      responseHeaders = result.headers ?? null
      if (responseHeaders) {
        extractQuotaStatusFromHeaders(responseHeaders)
      }

      fallbackUsage = result.data.usage as unknown as PartialApiUsage
      const assistantMsg: AssistantMessage = {
        type: 'assistant',
        message: {
          ...result.data,
          content: normalizeContentFromApi(
            result.data.content,
            tools,
            options.agentId,
          ),
        },
        requestId: streamRequestId,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(options.advisorModel ? { advisorModel: options.advisorModel } : {}),
      }
      fallbackMessage = assistantMsg
      yield assistantMsg
    } finally {
      if (fallbackMessage) {
        usage = updateUsage({ ...EMPTY_USAGE }, fallbackUsage)
        stopReason = fallbackMessage.message.stop_reason
        const cost = calculateUsdCost(resolvedModel, usage)
        totalCostUsd += addToTotalSessionCost(cost, usage, options.model)
      }
    }
  }

  try {
    let stream: RawStreamLike | null = null
    let streamResponse: Response | undefined

    const releaseStreamResources = (): void => {
      cleanupStream(stream)
      stream = null
      if (streamResponse?.body) {
        void streamResponse.body.cancel().catch(() => {})
        streamResponse = undefined
      }
    }

    try {
      const streamResult = yield* withRetry(
        getClient,
        async (client, _attempt, retryContext) => {
          attemptStart = Date.now()
          const params = paramsFromContext(retryContext)
          const response = await client.beta.messages
            .create(
              {
                ...params,
                stream: true,
              } as Parameters<typeof client.beta.messages.create>[0],
              { signal },
            )
            .withResponse()
          return {
            data: response.data as unknown as RawStreamLike,
            requestId: response.request_id ?? undefined,
            response: response.response,
          }
        },
        {
          maxRetries: options.maxRetries,
          model: options.model,
          thinkingConfig,
          fallbackModel: options.fallbackModel,
          fastMode: options.fastMode,
          signal,
          querySource: options.querySource,
        },
      )

      stream = streamResult.data
      streamRequestId = streamResult.requestId
      streamResponse = streamResult.response
      responseHeaders = streamResponse?.headers ?? null

      const newMessages: AssistantMessage[] = []
      const contentBlocks: Array<Record<string, unknown> | undefined> = []
      let partialMessage: BetaMessage | undefined
      let isAdvisorInProgress = false
      let lastEventTime: number | null = null
      let stallCount = 0
      let totalStallTime = 0

      // 90s idle watchdog
      const watchdogEnabled = isStreamWatchdogEnabled()
      const idleTimeoutMs = getStreamIdleTimeoutMs()
      const idleWarningMs = Math.floor(idleTimeoutMs / 2)
      let idleTimeoutHandle: ReturnType<typeof setTimeout> | undefined
      let idleWarningHandle: ReturnType<typeof setTimeout> | undefined
      let streamIdleAborted = false

      const clearIdleTimers = (): void => {
        if (idleTimeoutHandle) {
          clearTimeout(idleTimeoutHandle)
          idleTimeoutHandle = undefined
        }
        if (idleWarningHandle) {
          clearTimeout(idleWarningHandle)
          idleWarningHandle = undefined
        }
      }

      const resetIdleTimers = (): void => {
        if (!watchdogEnabled) return
        clearIdleTimers()
        idleWarningHandle = setTimeout(() => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${idleWarningMs}ms`,
            { level: 'warn' },
          )
        }, idleWarningMs)
        idleWarningHandle.unref?.()

        idleTimeoutHandle = setTimeout(() => {
          streamIdleAborted = true
          logEvent('tengu_streaming_idle_timeout', {
            timeoutMs: idleTimeoutMs,
            model: options.model as VerifiedNonSensitiveAnalyticsMetadata,
          })
          releaseStreamResources()
        }, idleTimeoutMs)
        idleTimeoutHandle.unref?.()
      }

      try {
        resetIdleTimers()

        for await (const part of stream) {
          const now = Date.now()
          if (lastEventTime !== null) {
            const gap = now - lastEventTime
            if (gap >= STALL_THRESHOLD_MS) {
              stallCount++
              totalStallTime += gap
              logEvent('tengu_streaming_stall', {
                stallMs: gap,
                stallCount,
              })
            }
          }
          lastEventTime = now
          resetIdleTimers()

          switch (part.type) {
            case 'message_start': {
              partialMessage = part.message
              ttftMs = now - attemptStart
              usage = updateUsage(
                usage,
                part.message?.usage as unknown as PartialApiUsage,
              )
              break
            }

            case 'content_block_start': {
              const block = part.content_block
              const blockType = (block as { type: string }).type
              if (blockType === 'tool_use') {
                contentBlocks[part.index] = { ...block, input: '' }
              } else if (blockType === 'server_tool_use') {
                contentBlocks[part.index] = { ...block, input: '' }
                if ((block as { name?: string }).name === 'advisor') {
                  isAdvisorInProgress = true
                  logEvent('tengu_advisor_tool_call', {})
                }
              } else if (blockType === 'text') {
                // Discard initial text on start to prevent first-delta duplication
                contentBlocks[part.index] = { ...block, text: '' }
              } else if (blockType === 'thinking') {
                contentBlocks[part.index] = {
                  ...block,
                  thinking: '',
                  signature: '',
                }
              } else {
                contentBlocks[part.index] = { ...block }
                if (blockType === 'advisor_tool_result') {
                  isAdvisorInProgress = false
                }
              }
              break
            }

            case 'content_block_delta': {
              const target = contentBlocks[part.index]
              if (!target) {
                logEvent('tengu_streaming_error', {
                  reason:
                    'content_block_not_found_delta' as VerifiedNonSensitiveAnalyticsMetadata,
                })
                throw new RangeError('Content block not found')
              }
              const delta = part.delta as unknown as Record<string, unknown>
              const deltaType = String(delta.type ?? '')
              switch (deltaType) {
                case 'text_delta':
                  if (target.type !== 'text') {
                    throw new Error(
                      `Expected text block for text_delta, got ${String(target.type)}`,
                    )
                  }
                  target.text = String(target.text ?? '') + String(delta.text ?? '')
                  break
                case 'input_json_delta':
                  if (
                    target.type !== 'tool_use' &&
                    target.type !== 'server_tool_use'
                  ) {
                    throw new Error(
                      `Expected tool_use block for input_json_delta, got ${String(target.type)}`,
                    )
                  }
                  target.input =
                    String(target.input ?? '') +
                    String(delta.partial_json ?? '')
                  break
                case 'thinking_delta':
                  if (target.type !== 'thinking') {
                    throw new Error(
                      `Expected thinking block for thinking_delta, got ${String(target.type)}`,
                    )
                  }
                  target.thinking =
                    String(target.thinking ?? '') +
                    String(delta.thinking ?? '')
                  break
                case 'signature_delta':
                  target.signature = String(delta.signature ?? '')
                  break
                case 'connector_text_delta':
                  target.connector_text =
                    String(target.connector_text ?? '') +
                    String(delta.connector_text ?? '')
                  break
                case 'citations_delta':
                default:
                  break
              }
              break
            }

            case 'content_block_stop': {
              const completed = contentBlocks[part.index]
              if (!completed) {
                throw new RangeError('Content block not found')
              }
              if (!partialMessage) {
                throw new Error('Message not found')
              }
              const assistantMsg: AssistantMessage = {
                type: 'assistant',
                message: {
                  ...partialMessage,
                  content: normalizeContentFromApi(
                    [completed as unknown as BetaContentBlock],
                    tools,
                    options.agentId,
                  ),
                },
                requestId: streamRequestId,
                uuid: randomUUID(),
                timestamp: new Date().toISOString(),
                ...(options.advisorModel
                  ? { advisorModel: options.advisorModel }
                  : {}),
              }
              newMessages.push(assistantMsg)
              yield assistantMsg
              break
            }

            case 'message_delta': {
              usage = updateUsage(
                usage,
                part.usage as unknown as PartialApiUsage,
              )
              stopReason = part.delta.stop_reason

              // Mutate last yielded message in-place so deferred transcript
              // writers observing the message reference pick up final usage/stop_reason
              const lastMsg = newMessages.at(-1)
              if (lastMsg) {
                lastMsg.message.usage = usage as unknown as BetaUsage
                lastMsg.message.stop_reason = stopReason
              }

              const costForPart = calculateUsdCost(resolvedModel, usage)
              totalCostUsd += addToTotalSessionCost(
                costForPart,
                usage,
                options.model,
              )

              const refusalMsg = getErrorMessageIfRefusal(
                stopReason,
                options.model,
              )
              if (refusalMsg) {
                yield refusalMsg
              }

              if (stopReason === 'max_tokens') {
                const maxOut =
                  options.maxOutputTokensOverride ??
                  getMaxOutputTokensForModel(options.model)
                logEvent('tengu_max_tokens_reached', {
                  maxOutputTokens: maxOut,
                })
                yield createAssistantApiErrorMessage({
                  content: `API Error: Response exceeded the ${maxOut} output token maximum. To configure this behavior, set the COPILOT_CLI_MAX_OUTPUT_TOKENS environment variable.`,
                  apiError: 'max_output_tokens',
                  error: 'max_output_tokens',
                })
              } else if (
                (stopReason as string | null) ===
                'model_context_window_exceeded'
              ) {
                logEvent('tengu_context_window_exceeded', {})
                yield createAssistantApiErrorMessage({
                  content:
                    'API Error: The model has reached its context window limit.',
                  apiError: 'max_output_tokens',
                  error: 'max_output_tokens',
                })
              }
              break
            }

            case 'message_stop':
            default:
              break
          }

          yield {
            type: 'stream_event',
            event: part,
            ...(part.type === 'message_start' ? { ttftMs } : {}),
          }
        }

        if (streamIdleAborted) {
          logEvent('tengu_stream_loop_exited_after_watchdog', {
            exit_path: 'clean' as VerifiedNonSensitiveAnalyticsMetadata,
          })
          throw new Error('Stream idle timeout - no chunks received')
        }

        if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
          logEvent('tengu_stream_no_events', {})
          throw new Error('Stream ended without receiving any events')
        }

        if (stallCount > 0) {
          logEvent('tengu_streaming_stall_summary', {
            stallCount,
            totalStallTime,
          })
        }

        if (responseHeaders) {
          extractQuotaStatusFromHeaders(responseHeaders)
        }
      } catch (streamingError) {
        if (streamIdleAborted) {
          logEvent('tengu_stream_loop_exited_after_watchdog', {
            exit_path: 'error' as VerifiedNonSensitiveAnalyticsMetadata,
          })
        }
        if (streamingError instanceof APIUserAbortError) {
          if (signal.aborted) {
            if (isAdvisorInProgress) {
              logEvent('tengu_advisor_tool_interrupted', {})
            }
            throw streamingError
          }
          throw new APIConnectionTimeoutError({
            message: 'Request timed out',
          })
        }

        if (isNonStreamingFallbackDisabled()) {
          logEvent('tengu_streaming_fallback_to_non_streaming', {
            fallback_disabled: true,
          })
          throw streamingError
        }

        logEvent('tengu_streaming_fallback_to_non_streaming', {
          fallback_disabled: false,
        })
        releaseStreamResources()
        yield* runFallback(is529Error(streamingError) ? 1 : 0)
      } finally {
        clearIdleTimers()
        releaseStreamResources()
      }
    } catch (errorFromRetry) {
      if (errorFromRetry instanceof FallbackTriggeredError) {
        throw errorFromRetry
      }
      if (errorFromRetry instanceof APIUserAbortError && signal.aborted) {
        logApiError({
          errorMessage: errorFromRetry.message,
          errorType: 'aborted',
          model: options.model,
          durationMs: Date.now() - overallStart,
          querySource: options.querySource,
          requestId: streamRequestId,
        })
        return
      }

      // 404 on stream creation -> fall back to non-streaming endpoint
      if (
        !didFallBackToNonStreaming &&
        errorFromRetry instanceof CannotRetryError &&
        errorFromRetry.originalError instanceof APIError &&
        errorFromRetry.originalError.status === 404
      ) {
        logEvent('tengu_streaming_fallback_to_non_streaming', {
          error: '404_stream_creation' as VerifiedNonSensitiveAnalyticsMetadata,
        })
        yield* runFallback(0)
      } else {
        const underlying =
          errorFromRetry instanceof CannotRetryError
            ? errorFromRetry.originalError
            : errorFromRetry
        const statusCode =
          underlying instanceof APIError ? underlying.status : undefined
        logApiError({
          errorMessage:
            underlying instanceof Error
              ? underlying.message
              : String(underlying),
          errorType: classifyApiError(underlying),
          statusCode,
          model: options.model,
          durationMs: Date.now() - overallStart,
          querySource: options.querySource,
          requestId: streamRequestId,
        })
        yield getAssistantMessageFromError(underlying, options.model)
        return
      }
    }

    // Post-success diagnostics & accounting
    if (isFeatureEnabled('PROMPT_CACHE_BREAK_DETECTION')) {
      void checkResponseForCacheBreak(
        options.querySource,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
        messages,
        options.agentId,
        streamRequestId,
      )
    }

    if (
      streamRequestId &&
      !options.agentId &&
      (options.querySource === 'sdk' ||
        options.querySource?.startsWith('repl_main_thread'))
    ) {
      setLastMainRequestId(streamRequestId)
    }

    const totalDuration = Date.now() - overallStart
    const attemptDuration = Date.now() - attemptStart
    logApiSuccessAndDuration({
      model: options.model,
      costUsd: totalCostUsd,
      durationMs: attemptDuration,
      durationMsIncludingRetries: totalDuration,
      usage,
      ttftMs,
      stopReason,
      requestId: streamRequestId,
      querySource: options.querySource,
      responseHeaders,
      fastMode: usage.speed === 'fast',
    })
  } finally {
    // Cleanup guarantees satisfied inside inner finally blocks
  }
}

/**
 * Primary streaming LLM entrypoint (wrapped in VCR record/replay in tests).
 */
export async function* queryModelWithStreaming(
  params: QueryModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemApiErrorMessage, void> {
  yield* withStreamingVcr(params.messages, () => queryModelInner(params))
}

/**
 * Non-streaming convenience wrapper that drains `queryModelWithStreaming` and
 * returns the final `AssistantMessage`.
 */
export async function queryModelWithoutStreaming(
  params: QueryModelParams,
): Promise<AssistantMessage> {
  let lastAssistant: AssistantMessage | null = null
  for await (const item of queryModelWithStreaming(params)) {
    if (item.type === 'assistant') {
      lastAssistant = item
    }
  }
  if (!lastAssistant) {
    if (params.signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return lastAssistant
}

/**
 * Sends a single lightweight non-streaming query using the small/fast model.
 */
export async function queryHaiku(params: {
  systemPrompt?: SystemPrompt
  userPrompt: string | MessageParam['content']
  outputFormat?: JsonOutputFormat
  signal: AbortSignal
  options?: Partial<QueryModelOptions>
}): Promise<AssistantMessage> {
  const userMessage = createUserMessage({ content: params.userPrompt })
  const [assistant] = await withVcr([userMessage], async () => [
    await queryModelWithoutStreaming({
      messages: [userMessage],
      systemPrompt: params.systemPrompt ?? asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: params.signal,
      options: {
        ...params.options,
        model: getSmallFastModel(),
        enablePromptCaching: params.options?.enablePromptCaching ?? false,
        outputFormat: params.outputFormat,
      },
    }),
  ])
  return assistant!
}

/**
 * Sends a single non-streaming query using a caller-specified model.
 */
export async function queryWithModel(params: {
  systemPrompt?: SystemPrompt
  userPrompt: string | MessageParam['content']
  outputFormat?: JsonOutputFormat
  signal: AbortSignal
  options: QueryModelOptions
}): Promise<AssistantMessage> {
  const userMessage = createUserMessage({ content: params.userPrompt })
  const [assistant] = await withVcr([userMessage], async () => [
    await queryModelWithoutStreaming({
      messages: [userMessage],
      systemPrompt: params.systemPrompt ?? asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: params.signal,
      options: {
        ...params.options,
        enablePromptCaching: params.options.enablePromptCaching ?? false,
        outputFormat: params.outputFormat,
      },
    }),
  ])
  return assistant!
}

/**
 * Verifies an Anthropic API key with a 1-token Haiku probe (skipped in
 * non-interactive sessions). Returns `false` on explicit invalid-key errors.
 */
export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  if (isNonInteractiveSession) {
    return true
  }
  const model = getSmallFastModel()
  const betas = getModelBetas(model)

  try {
    const gen = withRetry(
      () => getAnthropicClient({ apiKey, maxRetries: 3, model, source: 'verify_api_key' }),
      async client =>
        client.beta.messages.create({
          model: normalizeModelStringForApi(model),
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
          temperature: 1,
          ...(betas.length > 0 ? { betas } : {}),
          metadata: getApiMetadata(),
          ...getExtraBodyParams(),
        } as Parameters<typeof client.beta.messages.create>[0]),
      {
        maxRetries: 2,
        model,
        thinkingConfig: { type: 'disabled' },
      },
    )
    while (!(await gen.next()).done) {
      // Drain retry messages
    }
    return true
  } catch (error) {
    const underlying =
      error instanceof CannotRetryError ? error.originalError : error
    const msg =
      underlying instanceof Error ? underlying.message : String(underlying)
    if (
      msg.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ) ||
      (underlying instanceof APIError && underlying.status === 401)
    ) {
      return false
    }
    throw underlying
  }
}
