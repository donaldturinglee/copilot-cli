/**
 * Tier 4a Session Memory Compaction (`trySessionMemoryCompaction`):
 * Zero-LLM-call compaction replacing older history with the rolling
 * `session-memory/summary.md` while keeping `10k–40k` tail tokens intact
 * without splitting `tool_use`/`tool_result` pairs or split assistant
 * streaming messages (`adjustIndexToPreserveApiInvariants`).
 */

import type { UUID } from 'crypto'
import type { CompactionResult } from '../../types/forward.js'
import type {
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utilities/attachments.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import { executeSessionStartHooks } from '../../utilities/hooks.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  findLastCompactBoundaryIndex,
  isCompactBoundaryMessage,
} from '../../utilities/messages.js'
import { getMainLoopModel } from '../../utilities/model/model.js'
import { getPlan, getPlanFilePath } from '../../utilities/plans.js'
import { getTranscriptPath } from '../../utilities/session_storage.js'
import { tokenCountFromLastApiResponse } from '../../utilities/tokens.js'
import { extractDiscoveredToolNames } from '../../utilities/tool_search.js'
import { getFeatureValueCachedMayBeStale } from '../analytics/growthbook.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../analytics/index.js'
import {
  isSessionMemoryEmpty,
  truncateSessionMemoryForCompact,
} from '../session_memory/prompts.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  getSessionMemoryPath,
  waitForSessionMemoryExtraction,
} from '../session_memory/session_memory_utils.js'
import { estimateMessageTokens } from './micro_compact.js'
import { getCompactUserSummaryMessage } from './prompt.js'

export interface SessionMemoryCompactConfig {
  minTokens: number
  minTextBlockMessages: number
  maxTokens: number
}

export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}

let activeConfig: SessionMemoryCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG }
let configInitialized = false

export function setSessionMemoryCompactConfigForTesting(
  partial: Partial<SessionMemoryCompactConfig> | null,
): void {
  if (partial === null) {
    activeConfig = { ...DEFAULT_SM_COMPACT_CONFIG }
    configInitialized = false
    return
  }
  activeConfig = {
    ...DEFAULT_SM_COMPACT_CONFIG,
    ...partial,
  }
  configInitialized = true
}

export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
  return { ...activeConfig }
}

/**
 * Loads GrowthBook overrides (`tengu_sm_compact_config`) once per session.
 */
export function initSessionMemoryCompactConfig(): void {
  if (configInitialized) return
  configInitialized = true
  const remote = getFeatureValueCachedMayBeStale<
    Partial<SessionMemoryCompactConfig>
  >('tengu_sm_compact_config', {})
  activeConfig = {
    minTokens:
      typeof remote.minTokens === 'number' && remote.minTokens > 0
        ? remote.minTokens
        : DEFAULT_SM_COMPACT_CONFIG.minTokens,
    minTextBlockMessages:
      typeof remote.minTextBlockMessages === 'number' &&
      remote.minTextBlockMessages > 0
        ? Math.floor(remote.minTextBlockMessages)
        : DEFAULT_SM_COMPACT_CONFIG.minTextBlockMessages,
    maxTokens:
      typeof remote.maxTokens === 'number' && remote.maxTokens > 0
        ? remote.maxTokens
        : DEFAULT_SM_COMPACT_CONFIG.maxTokens,
  }
}

/**
 * Returns whether Tier 4a Session Memory Compaction is enabled.
 */
export function shouldUseSessionMemoryCompaction(): boolean {
  if (isEnvTruthy(process.env.ENABLE_COPILOT_CLI_SM_COMPACT) ||
      isEnvTruthy(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT)) {
    return true
  }
  if (isEnvTruthy(process.env.DISABLE_COPILOT_CLI_SM_COMPACT) ||
      isEnvTruthy(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT)) {
    return false
  }
  return (
    getFeatureValueCachedMayBeStale('tengu_session_memory', false) &&
    getFeatureValueCachedMayBeStale('tengu_sm_compact', false)
  )
}

function hasTextBlocks(msg: Message): boolean {
  if (msg.type === 'user') {
    const content = msg.message.content
    if (typeof content === 'string') return content.trim().length > 0
    return content.some(b => b.type === 'text' && b.text.trim().length > 0)
  }
  if (msg.type === 'assistant') {
    return msg.message.content.some(
      b => b.type === 'text' && b.text.trim().length > 0,
    )
  }
  return false
}

/**
 * Adjusts `startIndex` backward across two passes so the preserved tail never:
 * 1. Contains a `tool_result` without its originating assistant `tool_use`
 * 2. Splits streaming-emitted assistant messages sharing the same `message.id`
 */
export function adjustIndexToPreserveApiInvariants(
  messages: readonly Message[],
  startIndex: number,
  floorIndex = 0,
): number {
  let adjusted = Math.max(floorIndex, Math.min(startIndex, messages.length))

  // Pass 1: Ensure every tool_result in [adjusted..end) has its matching tool_use
  const neededToolUseIds = new Set<string>()
  const presentToolUseIds = new Set<string>()

  for (let i = adjusted; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          neededToolUseIds.add(block.tool_use_id)
        }
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          presentToolUseIds.add(block.id)
        }
      }
    }
  }

  for (const id of presentToolUseIds) {
    neededToolUseIds.delete(id)
  }

  while (neededToolUseIds.size > 0 && adjusted > floorIndex) {
    adjusted--
    const msg = messages[adjusted]!
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          neededToolUseIds.delete(block.id)
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          neededToolUseIds.add(block.tool_use_id)
        }
      }
    }
  }

  // Pass 2: Pull in any earlier split streaming assistant siblings sharing message.id
  const assistantMsgIds = new Set<string>()
  for (let i = adjusted; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.message.id) {
      assistantMsgIds.add(msg.message.id)
    }
  }

  if (assistantMsgIds.size > 0) {
    for (let i = adjusted - 1; i >= floorIndex; i--) {
      const msg = messages[i]!
      if (
        msg.type === 'assistant' &&
        msg.message.id &&
        assistantMsgIds.has(msg.message.id)
      ) {
        adjusted = i
      }
    }
  }

  return adjusted
}

/**
 * Computes the starting index of tail messages to keep verbatim (`10k–40k`
 * tokens and >= 5 text-bearing messages) without crossing a prior compact
 * boundary or violating API tool-pairing invariants.
 */
export function calculateMessagesToKeepIndex(
  messages: readonly Message[],
  lastSummarizedIndex: number,
  config: SessionMemoryCompactConfig = activeConfig,
): number {
  const lastBoundaryIdx = findLastCompactBoundaryIndex(messages)
  const floor = lastBoundaryIdx === -1 ? 0 : lastBoundaryIdx + 1

  let startIndex =
    lastSummarizedIndex >= 0
      ? Math.min(messages.length, lastSummarizedIndex + 1)
      : messages.length
  startIndex = Math.max(floor, startIndex)

  let totalTokens = 0
  let textBlockMessageCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i]!
    totalTokens += estimateMessageTokens([m])
    if (hasTextBlocks(m)) {
      textBlockMessageCount++
    }
  }

  const satisfied = (): boolean =>
    totalTokens >= config.maxTokens ||
    (totalTokens >= config.minTokens &&
      textBlockMessageCount >= config.minTextBlockMessages)

  while (!satisfied() && startIndex > floor) {
    startIndex--
    const m = messages[startIndex]!
    totalTokens += estimateMessageTokens([m])
    if (hasTextBlocks(m)) {
      textBlockMessageCount++
    }
  }

  return adjustIndexToPreserveApiInvariants(messages, startIndex, floor)
}

function buildPostCompactList(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}

/**
 * Attempts Tier 4a zero-LLM-call compaction using `session-memory/summary.md`.
 * Returns `null` whenever unavailable, empty, or over budget so the caller
 * falls through cleanly to Tier 4b LLM compaction.
 */
export async function trySessionMemoryCompaction(
  messages: readonly Message[],
  agentId?: string,
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  if (!shouldUseSessionMemoryCompaction()) {
    return null
  }

  try {
    initSessionMemoryCompactConfig()
    await waitForSessionMemoryExtraction()

    const sessionMemory = await getSessionMemoryContent()
    if (!sessionMemory) {
      logEvent('tengu_sm_compact_no_session_memory', {})
      return null
    }
    if (await isSessionMemoryEmpty(sessionMemory)) {
      logEvent('tengu_sm_compact_empty_template', {})
      return null
    }

    const lastSummarizedId = getLastSummarizedMessageId()
    let lastSummarizedIndex: number
    if (lastSummarizedId) {
      lastSummarizedIndex = messages.findIndex(m => m.uuid === lastSummarizedId)
      if (lastSummarizedIndex === -1) {
        logEvent('tengu_sm_compact_summarized_id_not_found', {})
        return null
      }
    } else {
      logEvent('tengu_sm_compact_resumed_session', {})
      lastSummarizedIndex = messages.length - 1
    }

    const keepStartIndex = calculateMessagesToKeepIndex(
      messages,
      lastSummarizedIndex,
      activeConfig,
    )
    const messagesToKeep = messages
      .slice(keepStartIndex)
      .filter(m => !isCompactBoundaryMessage(m))

    const { truncatedContent, wasTruncated } =
      truncateSessionMemoryForCompact(sessionMemory)
    const transcriptPath = getTranscriptPath()
    let summaryText = getCompactUserSummaryMessage(
      truncatedContent,
      true,
      transcriptPath,
      messagesToKeep.length > 0,
    )
    if (wasTruncated) {
      summaryText += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${getSessionMemoryPath()}`
    }

    const summaryMessage: UserMessage = createUserMessage({
      content: summaryText,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })

    const preTokens =
      tokenCountFromLastApiResponse(messages) || estimateMessageTokens(messages)
    const discoveredTools = [...extractDiscoveredToolNames(messages)].sort()

    const preservedSegment =
      messagesToKeep.length > 0
        ? {
            headUuid: messagesToKeep[0]!.uuid,
            anchorUuid: summaryMessage.uuid,
            tailUuid: messagesToKeep[messagesToKeep.length - 1]!.uuid,
          }
        : undefined

    const boundaryMarker: SystemCompactBoundaryMessage =
      createCompactBoundaryMessage(
        'auto',
        preTokens,
        {
          messagesSummarized: Math.max(0, messages.length - messagesToKeep.length),
          ...(preservedSegment ? { preservedSegment } : {}),
          ...(discoveredTools.length > 0
            ? { preCompactDiscoveredTools: discoveredTools }
            : {}),
        },
        messages.at(-1)?.uuid as UUID | undefined,
      )

    const attachments: AttachmentMessage[] = []
    const planContent = getPlan(agentId)
    if (planContent) {
      attachments.push(
        createAttachmentMessage({
          type: 'plan_file_reference',
          planFilePath: getPlanFilePath(agentId),
          planContent,
        }),
      )
    }

    const sessionStartRes = await executeSessionStartHooks({
      source: 'compact',
      model: getMainLoopModel(),
    })
    const hookResults: AttachmentMessage[] =
      sessionStartRes.additionalContexts.length > 0
        ? [
            createAttachmentMessage({
              type: 'hook_additional_context',
              content: sessionStartRes.additionalContexts,
              hookName: 'SessionStart',
            }),
          ]
        : []

    const result: CompactionResult = {
      boundaryMarker,
      summaryMessages: [summaryMessage],
      messagesToKeep,
      attachments,
      hookResults,
      preCompactTokenCount: preTokens,
    }

    const postCompactTokenCount = estimateMessageTokens(
      buildPostCompactList(result),
    )
    result.postCompactTokenCount = postCompactTokenCount

    if (
      autoCompactThreshold !== undefined &&
      postCompactTokenCount >= autoCompactThreshold
    ) {
      logEvent('tengu_sm_compact_threshold_exceeded', {
        postCompactTokenCount,
        autoCompactThreshold,
      })
      return null
    }

    logEvent('tengu_sm_compact_succeeded', {
      preCompactTokenCount: preTokens,
      postCompactTokenCount,
      keptMessages: messagesToKeep.length,
    })

    return result
  } catch (error) {
    logEvent('tengu_sm_compact_error', {
      error: (error instanceof Error ? error.name : 'unknown') as VerifiedNonSensitiveAnalyticsMetadata,
    })
    return null
  }
}
