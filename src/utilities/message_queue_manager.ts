export type QueuedPromptItem = {
  id: string
  text: string
  createdAt: number
  mode: 'prompt' | 'bash' | 'command'
}

export type QueueListener = (items: readonly QueuedPromptItem[]) => void

/**
 * Deterministic FIFO queue for user inputs submitted while an assistant turn
 * is actively streaming.
 */
export class MessageQueueManager {
  private items: QueuedPromptItem[] = []
  private listeners = new Set<QueueListener>()
  private seq = 0

  enqueue(
    text: string,
    mode: QueuedPromptItem['mode'] = 'prompt',
  ): QueuedPromptItem {
    const item: QueuedPromptItem = {
      id: `q-${++this.seq}-${Date.now()}`,
      text,
      createdAt: Date.now(),
      mode,
    }
    this.items = [...this.items, item]
    this.emit()
    return item
  }

  dequeue(): QueuedPromptItem | undefined {
    if (this.items.length === 0) return undefined
    const [head, ...rest] = this.items
    this.items = rest
    this.emit()
    return head
  }

  peek(): QueuedPromptItem | undefined {
    return this.items[0]
  }

  remove(id: string): boolean {
    const next = this.items.filter(i => i.id !== id)
    if (next.length === this.items.length) return false
    this.items = next
    this.emit()
    return true
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.emit()
  }

  getAll(): readonly QueuedPromptItem[] {
    return this.items
  }

  size(): number {
    return this.items.length
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.items)
    }
  }
}

const defaultQueue = new MessageQueueManager()

export function getDefaultMessageQueue(): MessageQueueManager {
  return defaultQueue
}
