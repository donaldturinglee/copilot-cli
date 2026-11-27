import { PASTE_END, PASTE_START, FOCUS_IN, FOCUS_OUT } from './csi.js'
import { BSU, ESU } from './dec.js'
import { createTokenizer, type TokenizerOptions } from './tokenize.js'
import type { SemanticEvent } from './types.js'

export type VtParser = {
  feed(chunk: string): SemanticEvent[]
  flush(): SemanticEvent[]
  reset(): void
}

function parseCsi(raw: string): SemanticEvent {
  if (raw === PASTE_START) return { type: 'pasteStart' }
  if (raw === PASTE_END) return { type: 'pasteEnd' }
  if (raw === FOCUS_IN) return { type: 'focus', focused: true }
  if (raw === FOCUS_OUT) return { type: 'focus', focused: false }
  if (raw === BSU) return { type: 'syncStart' }
  if (raw === ESU) return { type: 'syncEnd' }

  const body = raw.slice(2)
  const final = body.slice(-1)
  const inner = body.slice(0, -1)

  let idx = 0
  let prefix = ''
  if (inner.length > 0 && inner.charCodeAt(0) >= 0x3c && inner.charCodeAt(0) <= 0x3f) {
    prefix = inner[0]!
    idx = 1
  }

  let paramEnd = idx
  while (paramEnd < inner.length) {
    const code = inner.charCodeAt(paramEnd)
    if ((code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3a) {
      paramEnd++
    } else {
      break
    }
  }

  const paramStr = inner.slice(idx, paramEnd)
  const intermediates = inner.slice(paramEnd)
  const params =
    paramStr.length === 0
      ? []
      : paramStr.split(';').map(p => (p === '' ? 0 : parseInt(p, 10)))

  if (final === 'm' && prefix === '' && intermediates === '') {
    return { type: 'sgr', params: params.length === 0 ? [0] : params }
  }

  return { type: 'csi', prefix, params, intermediates, final, raw }
}

function parseOsc(raw: string): SemanticEvent {
  const stripped = raw.endsWith('\x1b\\')
    ? raw.slice(2, -2)
    : raw.endsWith('\x07')
      ? raw.slice(2, -1)
      : raw.slice(2)

  const semi = stripped.indexOf(';')
  const code = semi === -1 ? parseInt(stripped, 10) : parseInt(stripped.slice(0, semi), 10)
  const data = semi === -1 ? '' : stripped.slice(semi + 1)

  // OSC 8: hyperlink => 8 ; params ; url
  if (code === 8) {
    const sep = data.indexOf(';')
    if (sep !== -1) {
      const params = data.slice(0, sep)
      const url = data.slice(sep + 1)
      return { type: 'hyperlink', params, url: url.length > 0 ? url : null }
    }
  }

  // OSC 52: clipboard => 52 ; selection ; base64data
  if (code === 52) {
    const sep = data.indexOf(';')
    if (sep !== -1) {
      return {
        type: 'clipboard',
        selection: data.slice(0, sep),
        data: data.slice(sep + 1),
      }
    }
  }

  // OSC 9;4: progress indicator => 9 ; 4 ; state [; percent]
  if (code === 9 && data.startsWith('4;')) {
    const parts = data.slice(2).split(';')
    const state = parseInt(parts[0] ?? '0', 10)
    const percent = parts[1] !== undefined ? parseInt(parts[1], 10) : undefined
    return { type: 'progress', state: isNaN(state) ? 0 : state, percent }
  }

  return { type: 'osc', code: isNaN(code) ? -1 : code, data, raw }
}

function parseSequence(raw: string): SemanticEvent {
  if (raw.startsWith('\x1b[')) {
    return parseCsi(raw)
  }
  if (raw.startsWith('\x1b]')) {
    return parseOsc(raw)
  }
  if (raw.startsWith('\x1bP')) {
    const content = raw.endsWith('\x1b\\')
      ? raw.slice(2, -2)
      : raw.endsWith('\x07')
        ? raw.slice(2, -1)
        : raw.slice(2)
    return { type: 'dcs', content, raw }
  }
  if (raw.startsWith('\x1b') && raw.length >= 2) {
    const body = raw.slice(1)
    return {
      type: 'esc',
      intermediates: body.slice(0, -1),
      final: body.slice(-1),
      raw,
    }
  }
  return { type: 'text', value: raw }
}

/**
 * Streaming VT semantic parser layered over the raw escape tokenizer.
 */
export function createParser(options: TokenizerOptions = {}): VtParser {
  const tokenizer = createTokenizer(options)

  function mapTokens(tokens: ReturnType<typeof tokenizer.feed>): SemanticEvent[] {
    const events: SemanticEvent[] = []
    for (const token of tokens) {
      if (token.type === 'text') {
        events.push({ type: 'text', value: token.value })
      } else {
        events.push(parseSequence(token.value))
      }
    }
    return events
  }

  return {
    feed(chunk: string): SemanticEvent[] {
      return mapTokens(tokenizer.feed(chunk))
    },
    flush(): SemanticEvent[] {
      return mapTokens(tokenizer.flush())
    },
    reset(): void {
      tokenizer.reset()
    },
  }
}
