import type { MouseAction, MouseButton } from '../parse_keypress.js'
import { InkEvent } from './event.js'

export class ClickEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly col: number
  readonly row: number
  readonly button: MouseButton
  readonly action: MouseAction
  readonly shift: boolean
  readonly meta: boolean
  readonly ctrl: boolean

  constructor(
    type: 'click' | 'mousedown' | 'mouseup' | 'mousemove' | 'wheel',
    opts: {
      col: number
      row: number
      button: MouseButton
      action: MouseAction
      shift?: boolean
      meta?: boolean
      ctrl?: boolean
    },
  ) {
    super(type, { bubbles: true, cancelable: true })
    this.col = opts.col
    this.row = opts.row
    this.button = opts.button
    this.action = opts.action
    this.shift = opts.shift ?? false
    this.meta = opts.meta ?? false
    this.ctrl = opts.ctrl ?? false
  }
}
