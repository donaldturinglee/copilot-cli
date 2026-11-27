type Listener<T> = (payload: T) => void

/**
 * Lightweight typed event emitter honoring `immediatePropagationStopped` on
 * dispatched event objects so `ChordInterceptor` can suppress downstream listeners.
 */
export class TypedEventEmitter<TEvents extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof TEvents, Set<Listener<unknown>>>()

  on<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<unknown>)
    return () => {
      this.off(event, listener)
    }
  }

  off<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): void {
    const set = this.listeners.get(event)
    if (!set) return
    set.delete(listener as Listener<unknown>)
    if (set.size === 0) {
      this.listeners.delete(event)
    }
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return
    const snapshot = [...set]
    for (const fn of snapshot) {
      fn(payload)
      if (
        payload &&
        typeof payload === 'object' &&
        'immediatePropagationStopped' in payload &&
        (payload as { immediatePropagationStopped?: boolean })
          .immediatePropagationStopped
      ) {
        break
      }
    }
  }

  listenerCount<K extends keyof TEvents>(event: K): number {
    return this.listeners.get(event)?.size ?? 0
  }

  clear(): void {
    this.listeners.clear()
  }
}
