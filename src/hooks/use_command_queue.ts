import { useEffect, useState } from 'react'
import {
  getDefaultMessageQueue,
  type MessageQueueManager,
  type QueuedPromptItem,
} from '../utilities/message_queue_manager.js'

export function useCommandQueue(
  queueManager: MessageQueueManager = getDefaultMessageQueue(),
) {
  const [items, setItems] = useState<readonly QueuedPromptItem[]>(() =>
    queueManager.getAll(),
  )

  useEffect(() => {
    setItems(queueManager.getAll())
    return queueManager.subscribe(next => {
      setItems([...next])
    })
  }, [queueManager])

  return {
    items,
    enqueue: queueManager.enqueue.bind(queueManager),
    dequeue: queueManager.dequeue.bind(queueManager),
    remove: queueManager.remove.bind(queueManager),
    clear: queueManager.clear.bind(queueManager),
  }
}
