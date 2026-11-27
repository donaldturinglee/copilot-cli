import type { Token } from './types.js'

export type TokenizerOptions = {
  /** Recognize legacy X10 mouse reports: ESC [ M Cb Cx Cy (3 fixed bytes). */
  x10Mouse?: boolean
}

export type Tokenizer = {
  feed(chunk: string): Token[]
  flush(): Token[]
  buffer(): string
  reset(): void
}

type State =
  | 'GROUND'
  | 'ESC'
  | 'ESC_INTERMEDIATE'
  | 'CSI'
  | 'X10_MOUSE'
  | 'OSC'
  | 'OSC_ESC'
  | 'DCS'
  | 'DCS_ESC'
  | 'SS3'

/**
 * Streaming VT/ANSI escape sequence tokenizer.
 *
 * Splits arbitrary byte/UTF-16 chunks into `text` and complete `sequence`
 * tokens without losing incomplete escape prefixes across chunk boundaries.
 * Supports CSI, OSC (BEL or ST terminated), DCS (XTVERSION, ST terminated),
 * SS3 (`ESC O <final>`), 2-byte ESC sequences, and X10 mouse reports.
 */
export function createTokenizer(options: TokenizerOptions = {}): Tokenizer {
  const enableX10 = options.x10Mouse ?? false
  let state: State = 'GROUND'
  let seqBuf = ''
  let x10Remaining = 0

  function reset(): void {
    state = 'GROUND'
    seqBuf = ''
    x10Remaining = 0
  }

  function feed(chunk: string): Token[] {
    const tokens: Token[] = []
    let textBuf = ''

    const emitText = (): void => {
      if (textBuf.length > 0) {
        tokens.push({ type: 'text', value: textBuf })
        textBuf = ''
      }
    }

    const emitSeq = (): void => {
      if (seqBuf.length > 0) {
        tokens.push({ type: 'sequence', value: seqBuf })
        seqBuf = ''
      }
      state = 'GROUND'
    }

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!
      const code = chunk.charCodeAt(i)

      switch (state) {
        case 'GROUND': {
          if (code === 0x1b) {
            emitText()
            seqBuf = ch
            state = 'ESC'
          } else {
            textBuf += ch
          }
          break
        }

        case 'ESC': {
          if (ch === '[') {
            seqBuf += ch
            state = 'CSI'
          } else if (ch === ']') {
            seqBuf += ch
            state = 'OSC'
          } else if (ch === 'P') {
            seqBuf += ch
            state = 'DCS'
          } else if (ch === 'O' || ch === 'N') {
            seqBuf += ch
            state = 'SS3'
          } else if (code >= 0x20 && code <= 0x2f) {
            seqBuf += ch
            state = 'ESC_INTERMEDIATE'
          } else if (code === 0x1b) {
            // Double ESC (e.g. Meta+Escape or nested prefix)
            seqBuf += ch
            // Keep in ESC state if followed by CSI/SS3 (e.g. ESC ESC [ A)
          } else {
            seqBuf += ch
            emitSeq()
          }
          break
        }

        case 'ESC_INTERMEDIATE': {
          seqBuf += ch
          if (code >= 0x30 && code <= 0x7e) {
            emitSeq()
          } else if (code < 0x20 || code > 0x2f) {
            emitSeq()
          }
          break
        }

        case 'SS3': {
          seqBuf += ch
          emitSeq()
          break
        }

        case 'CSI': {
          // X10 mouse sequence: ESC [ M <Cb> <Cx> <Cy>
          if (enableX10 && ch === 'M' && seqBuf === '\x1b[') {
            seqBuf += ch
            x10Remaining = 3
            state = 'X10_MOUSE'
            break
          }
          seqBuf += ch
          // CSI final byte is in 0x40..0x7E
          if (code >= 0x40 && code <= 0x7e) {
            emitSeq()
          } else if (code === 0x1b) {
            // Aborted CSI followed immediately by new ESC
            seqBuf = seqBuf.slice(0, -1)
            emitSeq()
            seqBuf = '\x1b'
            state = 'ESC'
          }
          break
        }

        case 'X10_MOUSE': {
          seqBuf += ch
          x10Remaining--
          if (x10Remaining <= 0) {
            emitSeq()
          }
          break
        }

        case 'OSC': {
          if (code === 0x07) {
            seqBuf += ch
            emitSeq()
          } else if (code === 0x1b) {
            seqBuf += ch
            state = 'OSC_ESC'
          } else {
            seqBuf += ch
          }
          break
        }

        case 'OSC_ESC': {
          seqBuf += ch
          if (ch === '\\') {
            emitSeq()
          } else {
            state = 'OSC'
          }
          break
        }

        case 'DCS': {
          if (code === 0x07) {
            seqBuf += ch
            emitSeq()
          } else if (code === 0x1b) {
            seqBuf += ch
            state = 'DCS_ESC'
          } else {
            seqBuf += ch
          }
          break
        }

        case 'DCS_ESC': {
          seqBuf += ch
          if (ch === '\\') {
            emitSeq()
          } else {
            state = 'DCS'
          }
          break
        }
      }
    }

    emitText()
    return tokens
  }

  function flush(): Token[] {
    if (seqBuf.length === 0) return []
    const pending = seqBuf
    reset()
    return [{ type: 'sequence', value: pending }]
  }

  function buffer(): string {
    return seqBuf
  }

  return { feed, flush, buffer, reset }
}
