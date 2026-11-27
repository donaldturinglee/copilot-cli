import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

export type QueuedUiMessage = {
  id: string
  text: string
  createdAt: number
}

export type QueuedMessageContextValue = {
  messages: readonly QueuedUiMessage[]
  enqueue: (text: string) => QueuedUiMessage
  dequeue: () => QueuedUiMessage | undefined
  remove: (id: string) => void
  clear: () => void
}

const QueuedMessageContext = createContext<QueuedMessageContextValue>({
  messages: [],
  enqueue: text => ({ id: '0', text, createdAt: Date.now() }),
  dequeue: () => undefined,
  remove: () => {},
  clear: () => {},
})

export function QueuedMessageProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [messages, setMessages] = useState<QueuedUiMessage[]>([])

  const enqueue = useCallback((text: string): QueuedUiMessage => {
    const item: QueuedUiMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
    }
    setMessages(prev => [...prev, item])
    return item
  }, [])

  const dequeue = useCallback((): QueuedUiMessage | undefined => {
    let popped: QueuedUiMessage | undefined
    setMessages(prev => {
      if (prev.length === 0) return prev
      popped = prev[0]
      return prev.slice(1)
    })
    return popped
  }, [])

  const remove = useCallback((id: string) => {
    setMessages(prev => prev.filter(m => m.id !== id))
  }, [])

  const clear = useCallback(() => {
    setMessages([])
  }, [])

  const value = useMemo(
    () => ({ messages, enqueue, dequeue, remove, clear }),
    [messages, enqueue, dequeue, remove, clear],
  )

  return (
    <QueuedMessageContext.Provider value={value}>
      {children}
    </QueuedMessageContext.Provider>
  )
}

export function useQueuedMessages(): QueuedMessageContextValue {
  return useContext(QueuedMessageContext)
}
