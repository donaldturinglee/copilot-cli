/**
 * Utilities for mutating Anthropic API content block arrays while preserving
 * `tool_result` ordering requirements.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

/**
 * Inserts `block` into `content` in place:
 * - If `content` contains any `tool_result` blocks, inserts immediately after
 *   the last `tool_result` (appending `{ type: 'text', text: '.' }` if `block`
 *   would otherwise sit at the very end).
 * - Otherwise inserts immediately before the last block (or pushes if empty).
 */
export function insertBlockAfterToolResults<Block>(
  content: Array<ContentBlockParam | Block>,
  block: Block,
): void {
  let lastToolResultIdx = -1
  for (let i = content.length - 1; i >= 0; i--) {
    const item = content[i]
    if (
      item &&
      typeof item === 'object' &&
      'type' in item &&
      (item as { type?: unknown }).type === 'tool_result'
    ) {
      lastToolResultIdx = i
      break
    }
  }

  if (lastToolResultIdx >= 0) {
    const insertIdx = lastToolResultIdx + 1
    content.splice(insertIdx, 0, block)
    if (insertIdx === content.length - 1) {
      content.push({ type: 'text', text: '.' })
    }
    return
  }

  if (content.length === 0) {
    content.push(block)
  } else {
    content.splice(content.length - 1, 0, block)
  }
}
