import type { Writable } from 'stream'
import type { Diff } from './frame.js'
import { optimizeDiff } from './optimizer.js'
import type { StylePool } from './screen.js'
import {
  CLEAR_TERMINAL,
  cursorMove,
  cursorTo,
  ERASE_ENTIRE_LINE,
  eraseLines,
} from './termio/csi.js'
import { BSU, CURSOR_HIDE, CURSOR_SHOW, ESU } from './termio/dec.js'
import { LINK_END, link as oscLink } from './termio/osc.js'

export type TerminalWriterOptions = {
  stream: Writable
  stylePool: StylePool
  synchronizedOutput?: boolean
}

/**
 * Serialize a `Diff` (after single-pass peephole optimization) into an atomic
 * terminal byte string, optionally wrapped in DEC 2026 BSU/ESU synchronized
 * output markers to prevent visual tearing.
 */
export function serializeDiff(
  diff: Diff,
  stylePool: StylePool,
  synchronizedOutput = false,
): string {
  const optimized = optimizeDiff(diff)
  if (optimized.length === 0) return ''

  let out = ''
  let currentStyleId = 0
  let currentLink: string | undefined = undefined

  for (const patch of optimized) {
    switch (patch.type) {
      case 'stdout':
        out += patch.content
        break
      case 'clear':
        out += eraseLines(patch.count)
        break
      case 'clearTerminal':
        out += CLEAR_TERMINAL
        break
      case 'clearLine':
        out += ERASE_ENTIRE_LINE
        break
      case 'carriageReturn':
        out += '\r'
        break
      case 'cursorHide':
        out += CURSOR_HIDE
        break
      case 'cursorShow':
        out += CURSOR_SHOW
        break
      case 'cursorMove':
        out += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        out += cursorTo(patch.y + 1, patch.x + 1)
        break
      case 'style':
        out += stylePool.transition(currentStyleId, patch.styleId)
        currentStyleId = patch.styleId
        break
      case 'hyperlink':
        if (currentLink !== patch.url) {
          if (currentLink !== undefined) out += LINK_END
          if (patch.url !== undefined) out += oscLink(patch.url)
          currentLink = patch.url
        }
        break
    }
  }

  if (currentLink !== undefined) out += LINK_END
  if (currentStyleId !== 0) out += stylePool.transition(currentStyleId, 0)

  if (synchronizedOutput && out.length > 0) {
    return `${BSU}${out}${ESU}`
  }
  return out
}

export class TerminalWriter {
  private synchronizedOutput: boolean

  constructor(private readonly options: TerminalWriterOptions) {
    this.synchronizedOutput = options.synchronizedOutput ?? false
  }

  setSynchronizedOutput(enabled: boolean): void {
    this.synchronizedOutput = enabled
  }

  writeDiff(diff: Diff): string {
    const serialized = serializeDiff(
      diff,
      this.options.stylePool,
      this.synchronizedOutput,
    )
    if (serialized.length > 0) {
      this.options.stream.write(serialized)
    }
    return serialized
  }

  writeRaw(seq: string): void {
    if (seq.length > 0) {
      this.options.stream.write(seq)
    }
  }
}
