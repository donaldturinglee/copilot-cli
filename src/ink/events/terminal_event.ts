import type { TerminalResponse } from '../parse_keypress.js'
import { InkEvent } from './event.js'

export class TerminalEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly response: TerminalResponse

  constructor(response: TerminalResponse) {
    super('terminalResponse', { bubbles: false, cancelable: false })
    this.response = response
  }
}
