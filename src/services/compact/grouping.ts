/**
 * Groups conversation messages by API round (starting a new group whenever an
 * assistant message with a distinct `message.id` appears) so PTL head-trimming
 * never splits a streaming assistant turn or separates `tool_use` from its
 * following `tool_result`s.
 */

import type { Message } from '../../types/message.js'

/**
 * Partitions `messages` into contiguous API-round groups.
 */
export function groupMessagesByApiRound(
  messages: readonly Message[],
): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  let lastAssistantId: string | undefined

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const msgId = msg.message.id
      if (
        msgId &&
        lastAssistantId !== undefined &&
        msgId !== lastAssistantId &&
        current.length > 0
      ) {
        groups.push(current)
        current = []
      }
      if (msgId) {
        lastAssistantId = msgId
      }
    }
    current.push(msg)
  }

  if (current.length > 0) {
    groups.push(current)
  }

  return groups
}
