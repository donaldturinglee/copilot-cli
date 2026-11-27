import { InkEvent } from './event.js'

export class PasteEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly text: string
  readonly isEmpty: boolean

  constructor(text: string) {
    super('paste', { bubbles: true, cancelable: true })
    this.text = text
    this.isEmpty = text.length === 0
  }
}
