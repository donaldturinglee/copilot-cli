import type { Writable } from 'stream'
import { CLEAR_TERMINAL } from './termio/csi.js'

export function clearTerminal(
  stream: Writable = process.stdout,
): void {
  stream.write(CLEAR_TERMINAL)
}
