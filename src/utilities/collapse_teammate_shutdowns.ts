import type { Message } from '../types/message.js'

export function collapseTeammateShutdowns(
  messages: readonly Message[],
  verbose = false,
): Message[] {
  if (verbose) return [...messages]
  return messages.filter(msg => {
    if (msg.type === 'user' && msg.origin?.kind === 'task-notification') {
      const content =
        typeof msg.message.content === 'string' ? msg.message.content : ''
      if (content.includes('teammate_shutdown')) return false
    }
    return true
  })
}
