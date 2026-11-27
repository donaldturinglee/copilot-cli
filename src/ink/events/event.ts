export const EventPhase = {
  NONE: 0,
  CAPTURING_PHASE: 1,
  AT_TARGET: 2,
  BUBBLING_PHASE: 3,
} as const
export type EventPhase = (typeof EventPhase)[keyof typeof EventPhase]

export type InkEventInit = {
  bubbles?: boolean
  cancelable?: boolean
}

/**
 * Base DOM-style event supporting capture/target/bubble propagation,
 * `stopPropagation()`, `stopImmediatePropagation()`, and `preventDefault()`.
 */
export class InkEvent<TTarget = unknown> {
  readonly type: string
  readonly bubbles: boolean
  readonly cancelable: boolean
  readonly timeStamp: number

  target: TTarget | null = null
  currentTarget: TTarget | null = null
  eventPhase: EventPhase = EventPhase.NONE

  private _propagationStopped = false
  private _immediatePropagationStopped = false
  private _defaultPrevented = false

  constructor(type: string, init: InkEventInit = {}) {
    this.type = type
    this.bubbles = init.bubbles ?? true
    this.cancelable = init.cancelable ?? true
    this.timeStamp = performance.now()
  }

  get propagationStopped(): boolean {
    return this._propagationStopped
  }

  get immediatePropagationStopped(): boolean {
    return this._immediatePropagationStopped
  }

  get defaultPrevented(): boolean {
    return this._defaultPrevented
  }

  stopPropagation(): void {
    this._propagationStopped = true
  }

  stopImmediatePropagation(): void {
    this._propagationStopped = true
    this._immediatePropagationStopped = true
  }

  preventDefault(): void {
    if (this.cancelable) {
      this._defaultPrevented = true
    }
  }
}
