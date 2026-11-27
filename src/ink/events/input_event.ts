import { InkEvent } from './event.js'
import type { Key } from './keyboard_event.js'

/**
 * Input event delivered to `useInput` handlers and `ChordInterceptor`.
 */
export class InputEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly input: string
  readonly key: Key

  constructor(input: string, key: Key) {
    super('input', { bubbles: true, cancelable: true })
    this.input = input
    this.key = key
  }
}
