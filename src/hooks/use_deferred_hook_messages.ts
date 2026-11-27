import { useCallback, useState } from 'react'
import type { Message } from '../types/message.js'

export function useDeferredHookMessages(): {
  deferredMessages: readonly Message[]
  enqueueDeferredMessage: (msg: Message) => void
  drainDeferredMessages: () => Message[]
} {
  const [deferredMessages, setDeferredMessages] = useState<Message[]>([])

  const enqueueDeferredMessage = useCallback((msg: Message) => {
    setDeferredMessages(prev => [...prev, msg])
  }, [])

  const drainDeferredMessages = useCallback((): Message[] => {
    let drained: Message[] = []
    setDeferredMessages(prev => {
      drained = prev
      return []
    })
    return drained
  }, [])

  return { deferredMessages, enqueueDeferredMessage, drainDeferredMessages }
}
