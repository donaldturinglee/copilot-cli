import { InkEvent } from './event.js'

export class ResizeEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly columns: number
  readonly rows: number

  constructor(columns: number, rows: number) {
    super('resize', { bubbles: false, cancelable: false })
    this.columns = columns
    this.rows = rows
  }
}
