import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Message } from '../types/message.js'

export type ToolResultLookup = {
  resolvedIds: Set<string>
  erroredIds: Set<string>
  resultsById: Map<string, ToolResultBlockParam>
}

/**
 * Scan messages and index every `tool_result` block by `tool_use_id` so tool
 * use rows can render live/resolved/error states in O(1).
 */
export function buildToolResultLookup(
  messages: readonly Message[],
): ToolResultLookup {
  const resolvedIds = new Set<string>()
  const erroredIds = new Set<string>()
  const resultsById = new Map<string, ToolResultBlockParam>()

  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result') {
        resolvedIds.add(block.tool_use_id)
        resultsById.set(block.tool_use_id, block)
        if (block.is_error) {
          erroredIds.add(block.tool_use_id)
        }
      }
    }
  }

  return { resolvedIds, erroredIds, resultsById }
}

export function isToolResultOnlyUserMessage(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message.content
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(b => b.type === 'tool_result')
}
