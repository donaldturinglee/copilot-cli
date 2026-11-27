import { InkEvent } from './event.js'

export class TerminalFocusEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly focused: boolean

  constructor(focused: boolean) {
    super(focused ? 'terminalFocus' : 'terminalBlur', {
      bubbles: false,
      cancelable: false,
    })
    this.focused = focused
  }
}
