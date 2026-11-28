/**
 * Lightweight heuristic context token breakdown (`analyzeContext`) for
 * compaction telemetry and duplicate-file-read detection.
 */

import { roughTokenCountEstimation } from '../services/token_estimation.js'
import type { Message } from '../types/message.js'
import { normalizeMessagesForApi } from './messages.js'
import { jsonStringify } from './slow_operations.js'

export interface TokenStats {
  toolRequests: Record<string, number>
  toolResults: Record<string, number>
  humanMessages: number
  assistantMessages: number
  localCommandOutputs: number
  other: number
  attachments: Record<string, number>
  duplicateFileReads: number
  total: number
}

/**
 * Computes an approximate per-category token breakdown across `messages`.
 */
export function analyzeContext(messages: readonly Message[]): TokenStats {
  const stats: TokenStats = {
    toolRequests: {},
    toolResults: {},
    humanMessages: 0,
    assistantMessages: 0,
    localCommandOutputs: 0,
    other: 0,
    attachments: {},
    duplicateFileReads: 0,
    total: 0,
  }

  for (const msg of messages) {
    if (msg.type === 'attachment') {
      const key = msg.attachment.type
      stats.attachments[key] = (stats.attachments[key] ?? 0) + 1
    }
  }

  const normalized = normalizeMessagesForApi(messages)
  const toolNameById = new Map<string, string>()
  const readFilePathById = new Map<string, string>()
  const readTokensByPath = new Map<string, { count: number; tokens: number }>()

  for (const msg of normalized) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        const tokens = roughTokenCountEstimation(jsonStringify(block))
        stats.total += tokens
        if (block.type === 'tool_use') {
          toolNameById.set(block.id, block.name)
          stats.toolRequests[block.name] =
            (stats.toolRequests[block.name] ?? 0) + tokens
          if (
            block.name === 'Read' &&
            block.input &&
            typeof block.input === 'object' &&
            'file_path' in block.input &&
            typeof (block.input as { file_path?: unknown }).file_path === 'string'
          ) {
            readFilePathById.set(
              block.id,
              (block.input as { file_path: string }).file_path,
            )
          }
        } else if (block.type === 'text') {
          stats.assistantMessages += tokens
        } else {
          stats.other += tokens
        }
      }
      continue
    }

    const content = msg.message.content
    if (typeof content === 'string') {
      const tokens = roughTokenCountEstimation(content)
      stats.total += tokens
      if (content.includes('local-command-stdout')) {
        stats.localCommandOutputs += tokens
      } else {
        stats.humanMessages += tokens
      }
      continue
    }

    for (const block of content) {
      const tokens = roughTokenCountEstimation(jsonStringify(block))
      stats.total += tokens
      if (block.type === 'tool_result') {
        const toolName = toolNameById.get(block.tool_use_id) ?? 'unknown'
        stats.toolResults[toolName] =
          (stats.toolResults[toolName] ?? 0) + tokens
        const readPath = readFilePathById.get(block.tool_use_id)
        if (readPath) {
          const entry = readTokensByPath.get(readPath) ?? {
            count: 0,
            tokens: 0,
          }
          entry.count++
          entry.tokens += tokens
          readTokensByPath.set(readPath, entry)
        }
      } else if (block.type === 'text') {
        if (block.text.includes('local-command-stdout')) {
          stats.localCommandOutputs += tokens
        } else {
          stats.humanMessages += tokens
        }
      } else {
        stats.other += tokens
      }
    }
  }

  for (const entry of readTokensByPath.values()) {
    if (entry.count > 1) {
      stats.duplicateFileReads +=
        Math.floor(entry.tokens / entry.count) * (entry.count - 1)
    }
  }

  return stats
}

/**
 * Flattens `TokenStats` into numeric metrics suitable for analytics events.
 */
export function tokenStatsToMetrics(stats: TokenStats): Record<string, number> {
  const totalToolReq = Object.values(stats.toolRequests).reduce(
    (sum, v) => sum + v,
    0,
  )
  const totalToolRes = Object.values(stats.toolResults).reduce(
    (sum, v) => sum + v,
    0,
  )
  const pct = (value: number): number =>
    stats.total > 0 ? Math.round((value / stats.total) * 100) : 0

  return {
    totalTokens: stats.total,
    humanTokens: stats.humanMessages,
    humanPct: pct(stats.humanMessages),
    assistantTokens: stats.assistantMessages,
    assistantPct: pct(stats.assistantMessages),
    toolRequestTokens: totalToolReq,
    toolResultTokens: totalToolRes,
    toolResultPct: pct(totalToolRes),
    localCommandTokens: stats.localCommandOutputs,
    otherTokens: stats.other,
    duplicateFileReadTokens: stats.duplicateFileReads,
  }
}
