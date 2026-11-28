/**
 * Tier 2a time-based microcompact (`microcompactMessages`), conservative 4/3
 * token estimator (`estimateMessageTokens`), and gated Tier 2b cached-MC hooks.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { QuerySource } from '../../constants/query_source.js'
import {
  BASH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../../constants/tools.js'
import type { MicrocompactResult } from '../../query/deps.js'
import type { ToolUseContext } from '../../types/forward.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { isFeatureEnabled } from '../../utilities/feature_flags.js'
import { jsonStringify } from '../../utilities/slow_operations.js'
import { logEvent } from '../analytics/index.js'
import { notifyCacheDeletion } from '../api/prompt_cache_break_detection.js'
import { roughTokenCountEstimation } from '../token_estimation.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from './compact_warning_state.js'
import {
  getTimeBasedMcConfig,
  type TimeBasedMicrocompactConfig,
} from './time_based_mc_config.js'

export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
export const IMAGE_MAX_TOKEN_SIZE = 2_000

/**
 * The 9 tool names eligible for Tier 2a time-based microcompact clearing.
 */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
  FILE_READ_TOOL_NAME,
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

// Interface-compatible hooks for stripped/gated Tier 2b CACHED_MICROCOMPACT
const pinnedCacheEdits = new Map<number, Record<string, unknown>[]>()
let pendingCacheEdits: {
  trigger: 'auto'
  deletedToolIds: string[]
  baselineCacheDeletedTokens: number
} | null = null

export function consumePendingCacheEdits(): typeof pendingCacheEdits {
  const current = pendingCacheEdits
  pendingCacheEdits = null
  return current
}

export function getPinnedCacheEdits(): ReadonlyMap<
  number,
  Record<string, unknown>[]
> {
  return pinnedCacheEdits
}

export function pinCacheEdits(
  userMessageIndex: number,
  block: Record<string, unknown>,
): void {
  const list = pinnedCacheEdits.get(userMessageIndex) ?? []
  list.push(block)
  pinnedCacheEdits.set(userMessageIndex, list)
}

export function markToolsSentToApiState(): void {
  // No-op interface hook when CACHED_MICROCOMPACT is inactive
}

export function resetMicrocompactState(): void {
  pinnedCacheEdits.clear()
  pendingCacheEdits = null
}

function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }
  if (!Array.isArray(block.content)) {
    return 0
  }
  let total = 0
  for (const nested of block.content) {
    if (nested.type === 'text') {
      total += roughTokenCountEstimation(nested.text)
    } else if (
      nested.type === 'image' ||
      (nested as { type?: string }).type === 'document'
    ) {
      total += IMAGE_MAX_TOKEN_SIZE
    }
  }
  return total
}

/**
 * Estimates tokens across `messages` with a conservative 4/3 padding factor,
 * counting text, tool_result, image/document (2,000 each), thinking,
 * redacted_thinking, and tool_use blocks.
 */
export function estimateMessageTokens(messages: readonly Message[]): number {
  let totalTokens = 0

  for (const msg of messages) {
    if (msg.type === 'user') {
      const content = msg.message.content
      if (typeof content === 'string') {
        totalTokens += roughTokenCountEstimation(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            totalTokens += roughTokenCountEstimation(block.text)
          } else if (block.type === 'tool_result') {
            totalTokens += calculateToolResultTokens(block)
          } else if (
            block.type === 'image' ||
            (block as { type?: string }).type === 'document'
          ) {
            totalTokens += IMAGE_MAX_TOKEN_SIZE
          } else {
            totalTokens += roughTokenCountEstimation(jsonStringify(block))
          }
        }
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          totalTokens += roughTokenCountEstimation(block.text)
        } else if (block.type === 'thinking') {
          totalTokens += roughTokenCountEstimation(block.thinking)
        } else if (block.type === 'redacted_thinking') {
          totalTokens += roughTokenCountEstimation(block.data)
        } else if (block.type === 'tool_use') {
          totalTokens += roughTokenCountEstimation(
            block.name + jsonStringify(block.input ?? {}),
          )
        } else {
          totalTokens += roughTokenCountEstimation(jsonStringify(block))
        }
      }
    }
  }

  return Math.ceil(totalTokens * (4 / 3))
}

function isMainThreadSource(querySource?: QuerySource): boolean {
  return (
    !querySource ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'
  )
}

/**
 * Evaluates whether Tier 2a time-based microcompact should fire based on the
 * idle gap since the last assistant message timestamp.
 */
export function evaluateTimeBasedTrigger(
  messages: readonly Message[],
  querySource?: QuerySource,
  nowMs: number = Date.now(),
): { gapMinutes: number; config: TimeBasedMicrocompactConfig } | null {
  const config = getTimeBasedMcConfig()
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }

  let lastAssistant: AssistantMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'assistant') {
      lastAssistant = m
      break
    }
  }
  if (!lastAssistant) {
    return null
  }

  const lastTs = new Date(lastAssistant.timestamp).getTime()
  const gapMinutes = (nowMs - lastTs) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }

  return { gapMinutes, config }
}

function collectCompactableToolIds(messages: readonly Message[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
        ids.push(block.id)
      }
    }
  }
  return ids
}

/**
 * Non-destructively clears older tool results (beyond the latest `keepRecent`,
 * default 5) once the idle gap exceeds `gapThresholdMinutes` (default 60m).
 */
export function maybeTimeBasedMicrocompact(
  messages: readonly Message[],
  querySource?: QuerySource,
  nowMs: number = Date.now(),
): { messages: Message[]; tokensSaved: number; clearedCount: number } | null {
  const triggered = evaluateTimeBasedTrigger(messages, querySource, nowMs)
  if (!triggered) {
    return null
  }

  const compactableIds = collectCompactableToolIds(messages)
  const keepRecent = Math.max(1, triggered.config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))
  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  let clearedCount = 0

  const updated = messages.map(msg => {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) {
      return msg
    }
    let changed = false
    const nextContent = msg.message.content.map(block => {
      if (block.type !== 'tool_result') return block
      if (!clearSet.has(block.tool_use_id)) return block
      if (block.content === TIME_BASED_MC_CLEARED_MESSAGE) return block

      const prevTokens = calculateToolResultTokens(block)
      const clearedTokens = roughTokenCountEstimation(
        TIME_BASED_MC_CLEARED_MESSAGE,
      )
      tokensSaved += Math.max(0, prevTokens - clearedTokens)
      clearedCount++
      changed = true
      return {
        ...block,
        content: TIME_BASED_MC_CLEARED_MESSAGE,
      }
    })
    return changed
      ? ({
          ...msg,
          message: {
            ...msg.message,
            content: nextContent,
          },
        } as UserMessage)
      : msg
  })

  if (clearedCount === 0) {
    return null
  }

  logEvent('tengu_time_based_microcompact', {
    gapMinutes: Math.round(triggered.gapMinutes),
    clearedCount,
    tokensSaved,
    keepRecent,
  })
  suppressCompactWarning()
  resetMicrocompactState()
  if (isFeatureEnabled('PROMPT_CACHE_BREAK_DETECTION')) {
    notifyCacheDeletion(querySource)
  }

  return { messages: updated, tokensSaved, clearedCount }
}

/**
 * Primary Tier 2 microcompact entry wired into `QueryDeps.microcompact`.
 */
export async function microcompactMessages(
  messages: Message[],
  _toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  const timeBased = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBased) {
    return { messages: timeBased.messages }
  }

  return { messages }
}
