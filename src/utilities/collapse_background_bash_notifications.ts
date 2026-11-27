import type { Message } from '../types/message.js'

export function collapseBackgroundBashNotifications(
  messages: readonly Message[],
  verbose = false,
): Message[] {
  if (verbose) return [...messages]
  const out: Message[] = []
  let prevWasBgNotif = false
  for (const msg of messages) {
    const isBg =
      msg.type === 'system' &&
      msg.subtype === 'informational' &&
      msg.content.startsWith('Background task ')
    if (isBg && prevWasBgNotif) {
      out[out.length - 1] = msg
    } else {
      out.push(msg)
    }
    prevWasBgNotif = isBg
  }
  return out
}
