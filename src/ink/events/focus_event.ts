import { InkEvent } from './event.js'

export class FocusEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly relatedTarget: TTarget | null

  constructor(type: 'focus' | 'blur', relatedTarget: TTarget | null = null) {
    super(type, { bubbles: false, cancelable: false })
    this.relatedTarget = relatedTarget
  }
}
