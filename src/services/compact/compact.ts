/**
 * Tier 4b Full & Partial LLM Compaction (`compactConversation` and
 * `partialCompactConversation`):
 * - Executes `PreCompact` hooks and merges custom instructions
 * - Cache-sharing `runForkedAgent` 9-section summary (denying all tools,
 *   `maxTurns: 1`, `skipCacheWrite: true`) + streaming fallback
 * - Up to 3 Prompt-Too-Long (PTL) head-trim retries using API-round grouping
 * - Post-compact attachment restoration: up to 5 recent files (50k token budget,
 *   5k/file), invoked skills (25k budget, 5k/skill), plan file + plan-mode
 *   instructions, active async agents, and `SessionStart('compact')` hooks
 * - `PostCompact` hooks, `notifyCompaction`, `markPostCompaction`, and
 *   tail metadata re-appending (`reAppendSessionMetadata`)
 */

import type { UUID } from 'crypto'
import {
  getInvokedSkillsForAgent,
  markPostCompaction,
} from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/query_source.js'
import type { QueryDeps } from '../../query/deps.js'
import type { AppState } from '../../state/app_state_store.js'
import type {
  CanUseToolFn,
  CompactionResult,
  ToolUseContext,
} from '../../types/forward.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  HookResultMessage,
  Message,
  PartialCompactDirection,
  SystemCompactBoundaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utilities/attachments.js'
import type { CacheSafeParams } from '../../utilities/cache_safe_params.js'
import { analyzeContext, tokenStatsToMetrics } from '../../utilities/context_analysis.js'
import { getModelMaxOutputTokens } from '../../utilities/context.js'
import { isBareMode } from '../../utilities/env_utils.js'
import { isFeatureEnabled } from '../../utilities/feature_flags.js'
import {
  cacheToObject,
  type FileState,
  type FileStateCache,
} from '../../utilities/file_state_cache.js'
import { extractResultText, runForkedAgent } from '../../utilities/forked_agent.js'
import {
  executePostCompactHooks,
  executePreCompactHooks,
  executeSessionStartHooks,
} from '../../utilities/hooks.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  getAssistantMessageText,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
  normalizeMessagesForApi,
} from '../../utilities/messages.js'
import { getDefaultMainLoopModel } from '../../utilities/model/model.js'
import { getPlan, getPlanFilePath } from '../../utilities/plans.js'
import { readFileInRange } from '../../utilities/read_file_in_range.js'
import {
  isSessionActivityTrackingActive,
  sendSessionActivitySignal,
} from '../../utilities/session_activity.js'
import {
  getTranscriptPath,
  reAppendSessionMetadata,
} from '../../utilities/session_storage.js'
import { jsonStringify } from '../../utilities/slow_operations.js'
import { asSystemPrompt } from '../../utilities/system_prompt_type.js'
import { tokenCountWithEstimation } from '../../utilities/tokens.js'
import { extractDiscoveredToolNames } from '../../utilities/tool_search.js'
import { getFeatureValueCachedMayBeStale } from '../analytics/growthbook.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../analytics/index.js'
import { queryModelWithStreaming } from '../api/claude.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  startsWithApiErrorPrefix,
} from '../api/errors.js'
import { notifyCompaction } from '../api/prompt_cache_break_detection.js'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForMessages,
} from '../token_estimation.js'
import { groupMessagesByApiRound } from './grouping.js'
import { estimateMessageTokens } from './micro_compact.js'
import {
  getCompactPrompt,
  getCompactUserSummaryMessage,
  getPartialCompactPrompt,
} from './prompt.js'

export type { CompactionResult }

export const ERROR_MESSAGE_USER_ABORT = 'Compaction cancelled by user.'
export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = 'Not enough messages to compact.'
export const ERROR_MESSAGE_PROMPT_TOO_LONG = PROMPT_TOO_LONG_ERROR_MESSAGE
export const PTL_RETRY_MARKER =
  '[earlier conversation truncated for compaction retry]'

export const MAX_PTL_RETRIES = 3
export const MAX_COMPACT_OUTPUT_TOKENS = 20_000
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
const KEEP_ALIVE_INTERVAL_MS = 30_000

export interface RecompactionInfo {
  isRecompactionInChain: boolean
  turnsSincePreviousCompact: number
  previousCompactTurnId?: string
  autoCompactThreshold: number
  querySource?: QuerySource
}

export type CompactProgressEvent =
  | { type: 'hooks_start'; hookType: 'pre_compact' | 'session_start' | 'post_compact' }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

export interface CompactConversationOptions {
  onCompactProgress?: (event: CompactProgressEvent) => void
  deps?: QueryDeps
}

/**
 * Unconditionally denies every tool call during compaction so the summary
 * request stays strictly text-only while preserving the parent's tool schemas
 * for prompt-cache prefix reuse.
 */
export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny',
    message: 'Tool use is not allowed during compaction',
    decisionReason: {
      type: 'other',
      reason: 'Tool use is not allowed during compaction',
    },
  })
}

/**
 * Replaces inline `image` and `document` blocks (including nested inside
 * `tool_result` arrays) with compact text placeholders for fallback compaction.
 */
export function stripImagesFromMessages(
  messages: readonly Message[],
): Message[] {
  return messages.map(msg => {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) {
      return msg
    }
    let changed = false
    const nextContent = msg.message.content.map(block => {
      if (block.type === 'image') {
        changed = true
        return { type: 'text' as const, text: '[image]' }
      }
      if ((block as { type?: string }).type === 'document') {
        changed = true
        return { type: 'text' as const, text: '[document]' }
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        let nestedChanged = false
        const nextNested = block.content.map(nested => {
          if (nested.type === 'image') {
            nestedChanged = true
            return { type: 'text' as const, text: '[image]' }
          }
          if ((nested as { type?: string }).type === 'document') {
            nestedChanged = true
            return { type: 'text' as const, text: '[document]' }
          }
          return nested
        })
        if (nestedChanged) {
          changed = true
          return { ...block, content: nextNested }
        }
      }
      return block
    })
    return changed
      ? {
          ...msg,
          message: {
            ...msg.message,
            content: nextContent,
          },
        }
      : msg
  })
}

/**
 * Parses an Anthropic `prompt is too long: <actual> tokens > <limit> maximum`
 * error string to compute the exact token overflow gap, or returns `null`.
 */
export function getPromptTooLongTokenGap(errorText: string): number | null {
  const match = errorText.match(
    /(\d[\d,]*)\s+tokens\s*>\s*(\d[\d,]*)\s+maximum/i,
  )
  if (!match?.[1] || !match[2]) {
    return null
  }
  const actual = Number(match[1].replace(/,/g, ''))
  const limit = Number(match[2].replace(/,/g, ''))
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual <= limit) {
    return null
  }
  return actual - limit
}

/**
 * Drops oldest API-round groups from `messages` for a PTL compaction retry:
 * - Strips any prior `PTL_RETRY_MARKER` at index 0
 * - Drops enough oldest groups to cover `tokenGap`, or 20% of groups if
 *   `tokenGap` cannot be parsed (always retaining >= 1 group)
 * - Prepends a synthetic meta `PTL_RETRY_MARKER` user message if the trimmed
 *   head starts with an assistant message
 */
export function truncateHeadForPtlRetry(
  messages: readonly Message[],
  ptlErrorText: string,
): Message[] | null {
  const withoutMarker =
    messages[0]?.type === 'user' &&
    messages[0].message.content === PTL_RETRY_MARKER
      ? messages.slice(1)
      : messages

  const groups = groupMessagesByApiRound(withoutMarker)
  if (groups.length < 2) {
    return null
  }

  const tokenGap = getPromptTooLongTokenGap(ptlErrorText)
  let dropCount = 0

  if (tokenGap !== null) {
    let droppedTokens = 0
    for (let i = 0; i < groups.length - 1; i++) {
      droppedTokens += roughTokenCountEstimationForMessages(groups[i]!)
      dropCount++
      if (droppedTokens >= tokenGap) {
        break
      }
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }

  dropCount = Math.min(dropCount, groups.length - 1)
  if (dropCount <= 0) {
    return null
  }

  const kept = groups.slice(dropCount).flat()
  if (kept.length === 0) {
    return null
  }

  if (kept[0]!.type === 'assistant') {
    return [
      createUserMessage({
        content: PTL_RETRY_MARKER,
        isMeta: true,
      }),
      ...kept,
    ]
  }
  return kept
}

function mergeHookInstructions(
  userInstructions: string | undefined,
  hookInstructions: readonly string[],
): string | undefined {
  const parts = [
    userInstructions?.trim(),
    ...hookInstructions.map(s => s.trim()),
  ].filter((s): s is string => Boolean(s && s.length > 0))
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function truncateToTokens(content: string, maxTokens: number): string {
  const marker =
    '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]'
  const charBudget = maxTokens * 4 - marker.length
  if (content.length <= charBudget) {
    return content
  }
  const slice = content.slice(0, Math.max(0, charBudget))
  const lastNl = slice.lastIndexOf('\n')
  const cut = lastNl > 0 ? slice.slice(0, lastNl) : slice
  return `${cut}${marker}`
}

function shouldExcludeFromPostCompactRestore(
  filePath: string,
  agentId?: string,
): boolean {
  const planPath = getPlanFilePath(agentId)
  if (filePath === planPath) {
    return true
  }
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  if (
    normalized.endsWith('/instructions.md') ||
    normalized.endsWith('/instructions.local.md') ||
    normalized.endsWith('/claude.md') ||
    normalized.endsWith('/claude.local.md') ||
    normalized.endsWith('/memory.md')
  ) {
    return true
  }
  return false
}

function collectReadToolFilePaths(messages: readonly Message[]): Set<string> {
  const paths = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'Read' &&
        block.input &&
        typeof block.input === 'object' &&
        'file_path' in block.input &&
        typeof (block.input as { file_path?: unknown }).file_path === 'string'
      ) {
        paths.add((block.input as { file_path: string }).file_path)
      }
    }
  }
  return paths
}

/**
 * Restores up to 5 most recently accessed files (`5,000` tokens/file, `50,000`
 * cumulative token budget) as post-compact file attachments.
 */
export async function createPostCompactFileAttachments(
  preCompactReadFileState: Record<string, FileState>,
  readFileState: FileStateCache | undefined,
  agentId?: string,
  preservedMessages: readonly Message[] = [],
): Promise<AttachmentMessage[]> {
  const alreadyVisiblePaths = collectReadToolFilePaths(preservedMessages)
  const candidates = Object.entries(preCompactReadFileState)
    .filter(
      ([filePath]) =>
        !shouldExcludeFromPostCompactRestore(filePath, agentId) &&
        !alreadyVisiblePaths.has(filePath),
    )
    .sort((a, b) => b[1].timestamp - a[1].timestamp)

  const attachments: AttachmentMessage[] = []
  let usedTokens = 0

  for (const [filePath] of candidates) {
    if (attachments.length >= POST_COMPACT_MAX_FILES_TO_RESTORE) {
      break
    }
    const maxBytes = POST_COMPACT_MAX_TOKENS_PER_FILE * 4
    try {
      const res = await readFileInRange(filePath, {
        offset: 1,
        maxSizeBytes: maxBytes,
        truncateOnByteLimit: true,
      })
      const att = createAttachmentMessage({
        type: 'file',
        filename: filePath,
        content: res.content,
        truncated: res.truncatedByBytes,
      })
      const estTokens = roughTokenCountEstimation(jsonStringify(att.attachment))
      if (usedTokens + estTokens > POST_COMPACT_TOKEN_BUDGET) {
        continue
      }
      usedTokens += estTokens
      attachments.push(att)
      readFileState?.set(filePath, {
        content: res.content,
        timestamp: res.mtimeMs,
        isPartialView: res.truncatedByBytes,
      })
    } catch {
      // File removed or unreadable since last read
    }
  }

  return attachments
}

/**
 * Builds post-compact `invoked_skills` attachment (up to `5,000` tokens/skill,
 * `25,000` cumulative token budget, most-recent first).
 */
export function createSkillAttachmentIfNeeded(
  agentId: string | null = null,
): AttachmentMessage | null {
  const invoked = getInvokedSkillsForAgent(agentId)
  if (invoked.size === 0) {
    return null
  }
  const sorted = Array.from(invoked.values()).sort(
    (a, b) => b.invokedAt - a.invokedAt,
  )
  const skills: Array<{ name: string; path: string; content: string }> = []
  let usedTokens = 0

  for (const skill of sorted) {
    const truncated = truncateToTokens(
      skill.content,
      POST_COMPACT_MAX_TOKENS_PER_SKILL,
    )
    const tokens = roughTokenCountEstimation(truncated)
    if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) {
      break
    }
    usedTokens += tokens
    skills.push({
      name: skill.skillName,
      path: skill.skillPath,
      content: truncated,
    })
  }

  if (skills.length === 0) {
    return null
  }
  return createAttachmentMessage({
    type: 'invoked_skills',
    skills,
  })
}

function createPlanAttachmentIfNeeded(
  agentId?: string,
): AttachmentMessage | null {
  const planContent = getPlan(agentId)
  if (!planContent) {
    return null
  }
  return createAttachmentMessage({
    type: 'plan_file_reference',
    planFilePath: getPlanFilePath(agentId),
    planContent,
  })
}

function createPlanModeAttachmentIfNeeded(
  appState: AppState | undefined,
  agentId?: string,
): AttachmentMessage | null {
  if (appState?.toolPermissionContext.mode !== 'plan') {
    return null
  }
  const planFilePath = getPlanFilePath(agentId)
  return createAttachmentMessage({
    type: 'plan_mode',
    reminderType: 'full',
    isSubAgent: Boolean(agentId),
    planFilePath,
    planExists: getPlan(agentId) !== null,
  })
}

function createAsyncAgentAttachmentsIfNeeded(
  appState: AppState | undefined,
  currentAgentId?: string,
): AttachmentMessage[] {
  if (!appState?.tasks) return []
  const attachments: AttachmentMessage[] = []
  for (const task of Object.values(appState.tasks)) {
    if (task.type !== 'local_agent') continue
    if (task.status === 'pending') continue
    const rec = task as Record<string, unknown>
    if (rec.retrieved === true) continue
    if (currentAgentId && rec.agentId === currentAgentId) continue
    attachments.push(
      createAttachmentMessage({
        type: 'task_status',
        taskId: task.id,
        status: task.status,
        description: task.description ?? '',
        ...(typeof rec.deltaSummary === 'string'
          ? { deltaSummary: rec.deltaSummary }
          : {}),
        ...(typeof rec.outputFilePath === 'string'
          ? { outputFilePath: rec.outputFilePath }
          : {}),
      }),
    )
  }
  return attachments
}

async function streamCompactSummary(params: {
  messagesToSummarize: readonly Message[]
  summaryRequest: UserMessage
  context: ToolUseContext
  cacheSafeParams: CacheSafeParams
  deps?: QueryDeps
}): Promise<{
  summaryText: string
  usage?: CompactionResult['compactionUsage']
  isPtlError: boolean
}> {
  const { messagesToSummarize, summaryRequest, context, cacheSafeParams, deps } =
    params

  if (context.abortController.signal.aborted) {
    throw new Error(ERROR_MESSAGE_USER_ABORT)
  }

  let keepAliveTimer: ReturnType<typeof setInterval> | undefined
  if (isSessionActivityTrackingActive()) {
    keepAliveTimer = setInterval(() => {
      sendSessionActivitySignal()
    }, KEEP_ALIVE_INTERVAL_MS)
    keepAliveTimer.unref?.()
  }

  try {
    const useCachePrefix = getFeatureValueCachedMayBeStale(
      'tengu_compact_cache_prefix',
      true,
    )

    // Primary path: cache-sharing forked agent reusing parent prompt prefix
    if (useCachePrefix) {
      try {
        const forkRes = await runForkedAgent({
          promptMessages: [summaryRequest],
          cacheSafeParams: {
            ...cacheSafeParams,
            forkContextMessages: [...messagesToSummarize],
          },
          canUseTool: createCompactCanUseTool(),
          querySource: 'compact',
          forkLabel: 'compact',
          maxTurns: 1,
          skipCacheWrite: true,
          overrides: {
            abortController: context.abortController,
          },
          deps,
        })

        const assistantMsg = [...forkRes.messages]
          .reverse()
          .find((m): m is AssistantMessage => m.type === 'assistant')
        const text = assistantMsg
          ? getAssistantMessageText(assistantMsg).trim()
          : extractResultText(forkRes.messages, '').trim()

        if (text && text.startsWith('Prompt is too long')) {
          return { summaryText: text, isPtlError: true }
        }
        if (assistantMsg && text && !assistantMsg.isApiErrorMessage) {
          return {
            summaryText: text,
            usage: {
              input_tokens: forkRes.totalUsage.input_tokens,
              output_tokens: forkRes.totalUsage.output_tokens,
              cache_creation_input_tokens:
                forkRes.totalUsage.cache_creation_input_tokens,
              cache_read_input_tokens:
                forkRes.totalUsage.cache_read_input_tokens,
            },
            isPtlError: false,
          }
        }
      } catch (err) {
        if (context.abortController.signal.aborted) {
          throw new Error(ERROR_MESSAGE_USER_ABORT)
        }
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.startsWith('Prompt is too long')) {
          return { summaryText: msg, isPtlError: true }
        }
        // Fall through to regular streaming fallback
      }
    }

    // Fallback path: direct streaming completion with stripped images
    const ctxOpts = (context.options as { mainLoopModel?: string; tools?: readonly unknown[] } | undefined) ?? {}
    const model = ctxOpts.mainLoopModel ?? getDefaultMainLoopModel()
    const stripped = stripImagesFromMessages([
      ...getMessagesAfterCompactBoundary(messagesToSummarize),
      summaryRequest,
    ])
    const normalized = normalizeMessagesForApi(stripped)
    const callModelFn = deps?.callModel ?? queryModelWithStreaming

    let textParts: string[] = []
    let lastUsage: CompactionResult['compactionUsage']
    let sawErrorText: string | undefined

    for await (const event of callModelFn({
      messages: normalized,
      systemPrompt: asSystemPrompt([
        'You are a helpful AI assistant tasked with summarizing conversations.',
      ]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: context.abortController.signal,
      options: {
        model,
        querySource: 'compact',
        maxOutputTokensOverride: Math.min(
          MAX_COMPACT_OUTPUT_TOKENS,
          getModelMaxOutputTokens(model).upperLimit,
        ),
      },
    })) {
      if (event.type === 'assistant') {
        const chunkText = getAssistantMessageText(event).trim()
        if (event.isApiErrorMessage) {
          sawErrorText = chunkText
        } else if (chunkText) {
          textParts.push(chunkText)
        }
        if (event.message.usage) {
          lastUsage = {
            input_tokens: event.message.usage.input_tokens,
            output_tokens: event.message.usage.output_tokens,
            cache_creation_input_tokens:
              event.message.usage.cache_creation_input_tokens,
            cache_read_input_tokens:
              event.message.usage.cache_read_input_tokens,
          }
        }
      }
    }

    if (sawErrorText) {
      return {
        summaryText: sawErrorText,
        usage: lastUsage,
        isPtlError: sawErrorText.startsWith('Prompt is too long'),
      }
    }

    return {
      summaryText: textParts.join('\n\n').trim(),
      usage: lastUsage,
      isPtlError: false,
    }
  } finally {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer)
    }
  }
}

async function runSummaryWithPtlRetries(params: {
  initialMessages: readonly Message[]
  promptText: string
  context: ToolUseContext
  cacheSafeParams: CacheSafeParams
  deps?: QueryDeps
}): Promise<{
  summaryText: string
  usage?: CompactionResult['compactionUsage']
}> {
  let messagesToSummarize: Message[] = [...params.initialMessages]
  const summaryRequest = createUserMessage({ content: params.promptText })

  for (let attempt = 0; attempt <= MAX_PTL_RETRIES; attempt++) {
    const res = await streamCompactSummary({
      messagesToSummarize,
      summaryRequest,
      context: params.context,
      cacheSafeParams: params.cacheSafeParams,
      deps: params.deps,
    })

    if (res.isPtlError || res.summaryText.startsWith('Prompt is too long')) {
      if (attempt >= MAX_PTL_RETRIES) {
        logEvent('tengu_compact_failed', {
          reason: 'prompt_too_long' as VerifiedNonSensitiveAnalyticsMetadata,
        })
        throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
      }
      const truncated = truncateHeadForPtlRetry(
        messagesToSummarize,
        res.summaryText,
      )
      if (!truncated) {
        logEvent('tengu_compact_failed', {
          reason: 'prompt_too_long' as VerifiedNonSensitiveAnalyticsMetadata,
        })
        throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
      }
      logEvent('tengu_compact_ptl_retry', {
        attempt: attempt + 1,
        beforeCount: messagesToSummarize.length,
        afterCount: truncated.length,
      })
      messagesToSummarize = truncated
      continue
    }

    if (!res.summaryText) {
      throw new Error(
        'Failed to generate conversation summary - response did not contain valid text content',
      )
    }
    if (startsWithApiErrorPrefix(res.summaryText)) {
      throw new Error(res.summaryText)
    }

    return {
      summaryText: res.summaryText,
      usage: res.usage,
    }
  }

  throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
}

/**
 * Tier 4b full conversation compaction (`compactConversation`).
 */
export async function compactConversation(
  messages: readonly Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions = false,
  customInstructions?: string,
  isAutoCompact = false,
  recompactionInfo?: RecompactionInfo,
  options?: CompactConversationOptions,
): Promise<CompactionResult> {
  if (messages.length === 0) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
  }

  const trigger: 'auto' | 'manual' = isAutoCompact ? 'auto' : 'manual'
  const preCompactTokenCount = tokenCountWithEstimation(messages)
  const appState = (context.getAppState as (() => AppState) | undefined)?.()
  const agentId =
    typeof context.agentId === 'string' ? context.agentId : undefined
  const ctxOpts =
    (context.options as { mainLoopModel?: string } | undefined) ?? {}
  const model = ctxOpts.mainLoopModel ?? getDefaultMainLoopModel()

  try {
    // 1. PreCompact hooks
    options?.onCompactProgress?.({ type: 'hooks_start', hookType: 'pre_compact' })
    const preHookRes = await executePreCompactHooks({
      trigger,
      customInstructions: customInstructions ?? null,
      permissionMode: appState?.toolPermissionContext.mode,
    })
    const effectiveInstructions = mergeHookInstructions(
      customInstructions,
      preHookRes.additionalContexts,
    )

    // 2. LLM 9-section summary with up to 3 PTL head-trim retries
    options?.onCompactProgress?.({ type: 'compact_start' })
    const { summaryText, usage } = await runSummaryWithPtlRetries({
      initialMessages: messages,
      promptText: getCompactPrompt(effectiveInstructions),
      context,
      cacheSafeParams,
      deps: options?.deps,
    })

    // 3. Snapshot & clear readFileState + loadedNestedMemoryPaths
    const readFileState = context.readFileState as FileStateCache | undefined
    const preCompactReadFileState = readFileState
      ? cacheToObject(readFileState)
      : {}
    readFileState?.clear()
    const nestedLoaded = context.loadedNestedMemoryPaths as
      | Set<string>
      | undefined
    nestedLoaded?.clear()

    // 4. Rebuild post-compact attachments (5 files / 50k, skills / 25k, plan, agents)
    const fileAttachments = await createPostCompactFileAttachments(
      preCompactReadFileState,
      readFileState,
      agentId,
    )
    const agentAttachments = createAsyncAgentAttachmentsIfNeeded(
      appState,
      agentId,
    )
    const planAttachment = createPlanAttachmentIfNeeded(agentId)
    const planModeAttachment = createPlanModeAttachmentIfNeeded(
      appState,
      agentId,
    )
    const skillAttachment = createSkillAttachmentIfNeeded(agentId ?? null)

    const attachments: AttachmentMessage[] = [
      ...fileAttachments,
      ...agentAttachments,
      ...(planAttachment ? [planAttachment] : []),
      ...(planModeAttachment ? [planModeAttachment] : []),
      ...(skillAttachment ? [skillAttachment] : []),
    ]

    // 5. SessionStart('compact') hooks
    const hookResults: HookResultMessage[] = []
    if (!isBareMode()) {
      options?.onCompactProgress?.({
        type: 'hooks_start',
        hookType: 'session_start',
      })
      const sessionStartRes = await executeSessionStartHooks({
        source: 'compact',
        model,
        permissionMode: appState?.toolPermissionContext.mode,
      })
      if (sessionStartRes.additionalContexts.length > 0) {
        hookResults.push(
          createAttachmentMessage({
            type: 'hook_additional_context',
            content: sessionStartRes.additionalContexts,
            hookName: 'SessionStart',
          }),
        )
      }
    }

    // 6. Boundary + summary message + bookkeeping
    const discoveredTools = [...extractDiscoveredToolNames(messages)].sort()
    const boundaryMarker: SystemCompactBoundaryMessage =
      createCompactBoundaryMessage(
        trigger,
        preCompactTokenCount,
        {
          messagesSummarized: messages.length,
          ...(effectiveInstructions
            ? { userContext: effectiveInstructions }
            : {}),
          ...(discoveredTools.length > 0
            ? { preCompactDiscoveredTools: discoveredTools }
            : {}),
        },
        messages.at(-1)?.uuid as UUID | undefined,
      )

    const summaryMessage = createUserMessage({
      content: getCompactUserSummaryMessage(
        summaryText,
        suppressFollowUpQuestions,
        getTranscriptPath(),
        false,
      ),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })

    const postCompactMessages: Message[] = [
      boundaryMarker,
      summaryMessage,
      ...attachments,
      ...hookResults,
    ]
    const postCompactTokenCount = estimateMessageTokens(postCompactMessages)

    const breakdownMetrics = tokenStatsToMetrics(analyzeContext(messages))
    logEvent('tengu_compact', {
      trigger: trigger as VerifiedNonSensitiveAnalyticsMetadata,
      preCompactTokenCount,
      postCompactTokenCount,
      restoredFilesCount: fileAttachments.length,
      isRecompaction: Boolean(recompactionInfo?.isRecompactionInChain),
      ...breakdownMetrics,
    })

    if (isFeatureEnabled('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(recompactionInfo?.querySource ?? 'compact', agentId)
    }
    markPostCompaction()
    reAppendSessionMetadata()

    // 7. PostCompact hooks
    options?.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'post_compact',
    })
    const postHookRes = await executePostCompactHooks({
      trigger,
      compactSummary: summaryText,
      permissionMode: appState?.toolPermissionContext.mode,
    })

    const displayMessages = [
      ...preHookRes.additionalContexts,
      ...postHookRes.additionalContexts,
    ].filter(Boolean)

    return {
      boundaryMarker,
      summaryMessages: [summaryMessage],
      attachments,
      hookResults,
      preCompactTokenCount,
      postCompactTokenCount,
      truePostCompactTokenCount: postCompactTokenCount,
      ...(usage ? { compactionUsage: usage } : {}),
      ...(displayMessages.length > 0
        ? { userDisplayMessage: displayMessages.join('\n') }
        : {}),
    }
  } finally {
    options?.onCompactProgress?.({ type: 'compact_end' })
  }
}

/**
 * Partial conversation compaction (`'from'` summarizes tail keeping prefix;
 * `'up_to'` summarizes prefix keeping tail verbatim) used by `/rewind`
 * `summarize` mode.
 */
export async function partialCompactConversation(
  allMessages: readonly Message[],
  pivotMessage: Message,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  options?: {
    userFeedback?: string
    direction?: PartialCompactDirection
    deps?: QueryDeps
  },
): Promise<CompactionResult> {
  const direction: PartialCompactDirection = options?.direction ?? 'from'
  const activeMessages = getMessagesAfterCompactBoundary(allMessages)
  const pivotIndex = activeMessages.indexOf(pivotMessage)
  if (pivotIndex === -1) {
    throw new Error(
      'That message is no longer in the active context (snipped or pre-compact). Choose a more recent message.',
    )
  }

  const appState = (context.getAppState as (() => AppState) | undefined)?.()
  const agentId =
    typeof context.agentId === 'string' ? context.agentId : undefined
  const ctxOpts =
    (context.options as { mainLoopModel?: string } | undefined) ?? {}
  const model = ctxOpts.mainLoopModel ?? getDefaultMainLoopModel()

  const preHookRes = await executePreCompactHooks({
    trigger: 'manual',
    customInstructions: null,
    permissionMode: appState?.toolPermissionContext.mode,
  })
  const userFeedbackStr = options?.userFeedback?.trim()
    ? `User context: ${options.userFeedback.trim()}`
    : undefined
  const customInstructions = mergeHookInstructions(
    userFeedbackStr,
    preHookRes.additionalContexts,
  )

  const messagesToSummarize =
    direction === 'from'
      ? activeMessages.slice(pivotIndex)
      : activeMessages.slice(0, pivotIndex)
  const messagesToKeep =
    direction === 'from'
      ? activeMessages.slice(0, pivotIndex).filter(m => m.type !== 'progress')
      : activeMessages
          .slice(pivotIndex)
          .filter(
            m =>
              m.type !== 'progress' &&
              !isCompactBoundaryMessage(m) &&
              !(m.type === 'user' && m.isCompactSummary),
          )

  if (messagesToSummarize.length === 0) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
  }

  const inputForModel =
    direction === 'from' ? activeMessages : messagesToSummarize

  const { summaryText, usage } = await runSummaryWithPtlRetries({
    initialMessages: inputForModel,
    promptText: getPartialCompactPrompt(customInstructions, direction),
    context,
    cacheSafeParams,
    deps: options?.deps,
  })

  const readFileState = context.readFileState as FileStateCache | undefined
  const preCompactReadFileState = readFileState
    ? cacheToObject(readFileState)
    : {}
  readFileState?.clear()
  ;(context.loadedNestedMemoryPaths as Set<string> | undefined)?.clear()

  const fileAttachments = await createPostCompactFileAttachments(
    preCompactReadFileState,
    readFileState,
    agentId,
    messagesToKeep,
  )
  const planAttachment = createPlanAttachmentIfNeeded(agentId)
  const planModeAttachment = createPlanModeAttachmentIfNeeded(appState, agentId)
  const skillAttachment = createSkillAttachmentIfNeeded(agentId ?? null)

  const attachments: AttachmentMessage[] = [
    ...fileAttachments,
    ...(planAttachment ? [planAttachment] : []),
    ...(planModeAttachment ? [planModeAttachment] : []),
    ...(skillAttachment ? [skillAttachment] : []),
  ]

  const hookResults: HookResultMessage[] = []
  if (!isBareMode()) {
    const sessionStartRes = await executeSessionStartHooks({
      source: 'compact',
      model,
      permissionMode: appState?.toolPermissionContext.mode,
    })
    if (sessionStartRes.additionalContexts.length > 0) {
      hookResults.push(
        createAttachmentMessage({
          type: 'hook_additional_context',
          content: sessionStartRes.additionalContexts,
          hookName: 'SessionStart',
        }),
      )
    }
  }

  const summaryMessage = createUserMessage({
    content: getCompactUserSummaryMessage(
      summaryText,
      false,
      getTranscriptPath(),
      messagesToKeep.length > 0,
    ),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    summarizeMetadata: {
      messagesSummarized: messagesToSummarize.length,
      direction,
      ...(options?.userFeedback?.trim()
        ? { userContext: options.userFeedback.trim() }
        : {}),
    },
  })

  const preCompactTokenCount = tokenCountWithEstimation(activeMessages)
  const boundaryMarker = createCompactBoundaryMessage(
    'manual',
    preCompactTokenCount,
    {
      messagesSummarized: messagesToSummarize.length,
      ...(options?.userFeedback?.trim()
        ? { userContext: options.userFeedback.trim() }
        : {}),
    },
    activeMessages.at(-1)?.uuid as UUID | undefined,
  )

  if (messagesToKeep.length > 0) {
    boundaryMarker.compactMetadata.preservedSegment = {
      headUuid: messagesToKeep[0]!.uuid,
      anchorUuid:
        direction === 'from' ? boundaryMarker.uuid : summaryMessage.uuid,
      tailUuid: messagesToKeep[messagesToKeep.length - 1]!.uuid,
    }
  }

  if (isFeatureEnabled('PROMPT_CACHE_BREAK_DETECTION')) {
    notifyCompaction('compact', agentId)
  }
  markPostCompaction()
  reAppendSessionMetadata()

  await executePostCompactHooks({
    trigger: 'manual',
    compactSummary: summaryText,
    permissionMode: appState?.toolPermissionContext.mode,
  })

  const postCompactTokenCount = estimateMessageTokens([
    boundaryMarker,
    summaryMessage,
    ...messagesToKeep,
    ...attachments,
    ...hookResults,
  ])

  return {
    boundaryMarker,
    summaryMessages: [summaryMessage],
    messagesToKeep,
    attachments,
    hookResults,
    preCompactTokenCount,
    postCompactTokenCount,
    truePostCompactTokenCount: postCompactTokenCount,
    ...(usage ? { compactionUsage: usage } : {}),
  }
}
