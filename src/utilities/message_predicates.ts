/**
 * Pure leaf message classification predicates.
 */

import type { Message, UserMessage } from '../types/message.js'

/**
 * Returns true if `message` represents an interactive human prompt turn
 * (a non-meta user message that is not a tool result carrier).
 */
export function isHumanTurn(message: Message): message is UserMessage {
  return (
    message.type === 'user' &&
    !message.isMeta &&
    message.toolUseResult === undefined
  )
}
