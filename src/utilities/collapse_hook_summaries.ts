import type { Message } from '../types/message.js'

/**
 * Filter consecutive silent stop-hook summaries when not in verbose mode.
 */
export function collapseHookSummaries(
  messages: readonly Message[],
  verbose = false,
): Message[] {
  if (verbose) return [...messages]
  return messages.filter(msg => {
    if (msg.type === 'system' && msg.subtype === 'stop_hook_summary') {
      return msg.hasOutput || msg.hookErrors.length > 0
    }
    return true
  })
}
