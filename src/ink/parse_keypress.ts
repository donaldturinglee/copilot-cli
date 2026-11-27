/**
 * Terminal input protocol decoder.
 *
 * Decodes raw stdin chunks via the streaming termio tokenizer into:
 * - Keyboard events (legacy VT, xterm, SS3, Kitty Keyboard Protocol `CSI u`,
 *   `modifyOtherKeys`, Ctrl/Alt/Meta/Shift/Super modifiers)
 * - Bracketed Paste events (`\x1b[200~`...`\x1b[201~`, preserving empty pastes
 *   so downstream handlers can trigger clipboard image reads)
 * - Mouse events (SGR `\x1b[<btn;col;rowM/m` & legacy X10 `\x1b[M...`)
 * - Terminal focus events (`CSI I` / `CSI O`)
 * - Inbound terminal query responses (`DECRPM`, `DA1`, `DA2`, `kittyKeyboard`,
 *   `cursorPosition`, `osc` / OSC 11, `xtversion`)
 */

import { FOCUS_IN, FOCUS_OUT, PASTE_END, PASTE_START } from './termio/csi.js'
import { createTokenizer, type Tokenizer } from './termio/tokenize.js'

// eslint-disable-next-line no-control-regex
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/
// eslint-disable-next-line no-control-regex
const FN_KEY_RE = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/
// eslint-disable-next-line no-control-regex
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u$/
// eslint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~$/
// eslint-disable-next-line no-control-regex
const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/
// eslint-disable-next-line no-control-regex
const DA1_RE = /^\x1b\[\?([\d;]*)c$/
// eslint-disable-next-line no-control-regex
const DA2_RE = /^\x1b\[>([\d;]*)c$/
// eslint-disable-next-line no-control-regex
const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/
// eslint-disable-next-line no-control-regex
const OSC_RESPONSE_RE = /^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$/s
// eslint-disable-next-line no-control-regex
const XTVERSION_RE = /^\x1bP>\|(.*?)(?:\x07|\x1b\\)$/s
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/

export const DECRPM_STATUS = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
} as const

export type TerminalResponse =
  | { type: 'decrpm'; mode: number; status: number }
  | { type: 'da1'; params: number[] }
  | { type: 'da2'; params: number[] }
  | { type: 'kittyKeyboard'; flags: number }
  | { type: 'cursorPosition'; row: number; col: number }
  | { type: 'osc'; code: number; data: string }
  | { type: 'xtversion'; name: string }

export type ParsedKey = {
  kind: 'key'
  name: string
  fn: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super: boolean
  sequence: string
  raw: string
  isPasted: boolean
  /** True when bracketed paste markers contained zero text (clipboard image signal). */
  isEmptyPaste?: boolean
}

export type MouseButton =
  | 'left'
  | 'middle'
  | 'right'
  | 'wheelUp'
  | 'wheelDown'
  | 'none'

export type MouseAction = 'press' | 'release' | 'drag' | 'move' | 'wheel'

export type ParsedMouse = {
  kind: 'mouse'
  button: MouseButton
  action: MouseAction
  /** 0-based terminal column */
  col: number
  /** 0-based terminal row */
  row: number
  shift: boolean
  meta: boolean
  ctrl: boolean
  raw: string
}

export type ParsedFocus = {
  kind: 'focus'
  focused: boolean
  raw: string
}

export type ParsedResponse = {
  kind: 'response'
  sequence: string
  response: TerminalResponse
}

export type ParsedInput =
  | ParsedKey
  | ParsedMouse
  | ParsedFocus
  | ParsedResponse

export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  _tokenizer?: Tokenizer
}

export const INITIAL_STATE: KeyParseState = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
}

function createPasteKey(content: string): ParsedKey {
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: content,
    raw: content,
    isPasted: true,
    isEmptyPaste: content.length === 0,
  }
}

function splitNumericParams(params: string): number[] {
  if (!params) return []
  return params
    .split(';')
    .filter(p => p.length > 0)
    .map(p => parseInt(p, 10))
}

export function parseTerminalResponse(s: string): TerminalResponse | null {
  if (s.startsWith('\x1b[')) {
    let m: RegExpExecArray | null
    if ((m = DECRPM_RE.exec(s))) {
      return {
        type: 'decrpm',
        mode: parseInt(m[1]!, 10),
        status: parseInt(m[2]!, 10),
      }
    }
    if ((m = DA1_RE.exec(s))) {
      return { type: 'da1', params: splitNumericParams(m[1]!) }
    }
    if ((m = DA2_RE.exec(s))) {
      return { type: 'da2', params: splitNumericParams(m[1]!) }
    }
    if ((m = KITTY_FLAGS_RE.exec(s))) {
      return { type: 'kittyKeyboard', flags: parseInt(m[1]!, 10) }
    }
    if ((m = CURSOR_POSITION_RE.exec(s))) {
      return {
        type: 'cursorPosition',
        row: parseInt(m[1]!, 10),
        col: parseInt(m[2]!, 10),
      }
    }
    return null
  }

  if (s.startsWith('\x1b]')) {
    const m = OSC_RESPONSE_RE.exec(s)
    if (m) {
      return { type: 'osc', code: parseInt(m[1]!, 10), data: m[2]! }
    }
  }

  if (s.startsWith('\x1bP')) {
    const m = XTVERSION_RE.exec(s)
    if (m) {
      return { type: 'xtversion', name: m[1]! }
    }
  }

  return null
}

function decodeMouseButton(code: number, isRelease: boolean): {
  button: MouseButton
  action: MouseAction
  shift: boolean
  meta: boolean
  ctrl: boolean
} {
  const shift = (code & 4) !== 0
  const meta = (code & 8) !== 0
  const ctrl = (code & 16) !== 0
  const isMotion = (code & 32) !== 0
  const isWheel = (code & 64) !== 0
  const low = code & 3

  if (isWheel) {
    return {
      button: low === 0 ? 'wheelUp' : 'wheelDown',
      action: 'wheel',
      shift,
      meta,
      ctrl,
    }
  }

  let button: MouseButton = 'none'
  if (low === 0) button = 'left'
  else if (low === 1) button = 'middle'
  else if (low === 2) button = 'right'

  let action: MouseAction
  if (isRelease) {
    action = 'release'
  } else if (isMotion) {
    action = button === 'none' ? 'move' : 'drag'
  } else {
    action = 'press'
  }

  return { button, action, shift, meta, ctrl }
}

export function parseMouseEvent(seq: string): ParsedMouse | null {
  const sgr = SGR_MOUSE_RE.exec(seq)
  if (sgr) {
    const code = parseInt(sgr[1]!, 10)
    const col = Math.max(0, parseInt(sgr[2]!, 10) - 1)
    const row = Math.max(0, parseInt(sgr[3]!, 10) - 1)
    const isRelease = sgr[4] === 'm'
    const decoded = decodeMouseButton(code, isRelease)
    return {
      kind: 'mouse',
      ...decoded,
      col,
      row,
      raw: seq,
    }
  }

  // Legacy X10 mouse: ESC [ M Cb Cx Cy (values offset by 32)
  if (seq.length === 6 && seq.startsWith('\x1b[M')) {
    const cb = seq.charCodeAt(3) - 32
    const cx = Math.max(0, seq.charCodeAt(4) - 33)
    const cy = Math.max(0, seq.charCodeAt(5) - 33)
    const isRelease = (cb & 3) === 3 && (cb & 64) === 0
    const decoded = decodeMouseButton(cb, isRelease)
    return {
      kind: 'mouse',
      ...decoded,
      col: cx,
      row: cy,
      raw: seq,
    }
  }

  return null
}

function decodeModifierBits(modParam: number): {
  shift: boolean
  meta: boolean
  option: boolean
  ctrl: boolean
  super: boolean
} {
  const bits = Math.max(0, modParam - 1)
  const alt = (bits & 2) !== 0
  return {
    shift: (bits & 1) !== 0,
    meta: alt,
    option: alt,
    ctrl: (bits & 4) !== 0,
    super: (bits & 8) !== 0,
  }
}

function codepointToKeyName(codepoint: number): string {
  switch (codepoint) {
    case 9:
      return 'tab'
    case 13:
      return 'return'
    case 27:
      return 'escape'
    case 32:
      return 'space'
    case 127:
      return 'backspace'
    case 57344:
      return 'escape'
    case 57345:
      return 'return'
    case 57346:
      return 'tab'
    case 57347:
      return 'backspace'
    case 57348:
      return 'insert'
    case 57349:
      return 'delete'
    case 57350:
      return 'left'
    case 57351:
      return 'right'
    case 57352:
      return 'up'
    case 57353:
      return 'down'
    case 57354:
      return 'pageup'
    case 57355:
      return 'pagedown'
    case 57356:
      return 'home'
    case 57357:
      return 'end'
    default:
      if (codepoint >= 32 && codepoint <= 0x10ffff) {
        return String.fromCodePoint(codepoint).toLowerCase()
      }
      return ''
  }
}

const KEY_NAME_MAP: Record<string, string> = {
  OP: 'f1',
  OQ: 'f2',
  OR: 'f3',
  OS: 'f4',
  '[11~': 'f1',
  '[12~': 'f2',
  '[13~': 'f3',
  '[14~': 'f4',
  '[[A': 'f1',
  '[[B': 'f2',
  '[[C': 'f3',
  '[[D': 'f4',
  '[[E': 'f5',
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[E': 'clear',
  '[F': 'end',
  '[H': 'home',
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OE: 'clear',
  OF: 'end',
  OH: 'home',
  '[1~': 'home',
  '[2~': 'insert',
  '[3~': 'delete',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  '[7~': 'home',
  '[8~': 'end',
  '[Z': 'tab',
}

export function parseKeypress(raw: string): ParsedKey {
  const key: ParsedKey = {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: raw,
    raw,
    isPasted: false,
  }

  if (raw.length === 0) return key

  // Kitty keyboard protocol: ESC [ codepoint [; modifier] u
  const csiU = CSI_U_RE.exec(raw)
  if (csiU) {
    const codepoint = parseInt(csiU[1]!, 10)
    const modParam = csiU[2] ? parseInt(csiU[2], 10) : 1
    const mods = decodeModifierBits(modParam)
    key.name = codepointToKeyName(codepoint)
    key.shift = mods.shift
    key.meta = mods.meta
    key.option = mods.option
    key.ctrl = mods.ctrl
    key.super = mods.super
    if (
      codepoint >= 32 &&
      codepoint < 127 &&
      !mods.ctrl &&
      !mods.meta &&
      !mods.super
    ) {
      const ch = String.fromCodePoint(codepoint)
      key.sequence = mods.shift ? ch.toUpperCase() : ch
    }
    return key
  }

  // xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
  const mok = MODIFY_OTHER_KEYS_RE.exec(raw)
  if (mok) {
    const modParam = parseInt(mok[1]!, 10)
    const codepoint = parseInt(mok[2]!, 10)
    const mods = decodeModifierBits(modParam)
    key.name = codepointToKeyName(codepoint)
    key.shift = mods.shift
    key.meta = mods.meta
    key.option = mods.option
    key.ctrl = mods.ctrl
    key.super = mods.super
    return key
  }

  if (raw === '\r') {
    key.name = 'return'
    return key
  }
  if (raw === '\n') {
    key.name = 'enter'
    return key
  }
  if (raw === '\t') {
    key.name = 'tab'
    return key
  }
  if (raw === '\b' || raw === '\x7f') {
    key.name = 'backspace'
    return key
  }
  if (raw === '\x1b\b' || raw === '\x1b\x7f') {
    key.name = 'backspace'
    key.meta = true
    key.option = true
    return key
  }
  if (raw === '\x1b' || raw === '\x1b\x1b') {
    key.name = 'escape'
    key.meta = raw.length === 2
    return key
  }
  if (raw === ' ') {
    key.name = 'space'
    return key
  }
  if (raw === '\x1b ') {
    key.name = 'space'
    key.meta = true
    key.option = true
    return key
  }
  if (raw === '\x1b\r' || raw === '\x1b\n') {
    key.name = 'return'
    key.meta = true
    key.option = true
    return key
  }

  // Shift+Tab: ESC [ Z
  if (raw === '\x1b[Z') {
    key.name = 'tab'
    key.shift = true
    return key
  }

  // Ctrl+A .. Ctrl+Z (0x01..0x1A)
  if (raw.length === 1) {
    const code = raw.charCodeAt(0)
    if (code >= 1 && code <= 26) {
      key.name = String.fromCharCode(code + 96)
      key.ctrl = true
      return key
    }
    if (code === 0x1f) {
      key.name = '_'
      key.ctrl = true
      return key
    }
    if (code === 0x1c) {
      key.name = '\\'
      key.ctrl = true
      return key
    }
    if (code >= 65 && code <= 90) {
      key.name = raw.toLowerCase()
      key.shift = true
      return key
    }
    if (code >= 97 && code <= 122) {
      key.name = raw
      return key
    }
    key.name = raw
    return key
  }

  // Meta + single alphanumeric char
  const metaMatch = META_KEY_CODE_RE.exec(raw)
  if (metaMatch) {
    const ch = metaMatch[1]!
    key.name = ch.toLowerCase()
    key.meta = true
    key.option = true
    key.shift = /^[A-Z]$/.test(ch)
    return key
  }

  // Meta + Ctrl char (e.g. ESC + 0x01)
  if (raw.length === 2 && raw[0] === '\x1b') {
    const code = raw.charCodeAt(1)
    if (code >= 1 && code <= 26) {
      key.name = String.fromCharCode(code + 96)
      key.ctrl = true
      key.meta = true
      key.option = true
      return key
    }
    key.name = raw[1]!.toLowerCase()
    key.meta = true
    key.option = true
    return key
  }

  // Standard CSI / SS3 navigation & function keys
  const fnMatch = FN_KEY_RE.exec(raw)
  if (fnMatch) {
    const prefix = fnMatch[1]!
    const num = fnMatch[2]
    const tildeMod = fnMatch[3]
    const tildeFinal = fnMatch[4]
    const letterMod = fnMatch[5]
    const letterFinal = fnMatch[6]

    const modStr = tildeMod ?? letterMod
    if (modStr) {
      const mods = decodeModifierBits(parseInt(modStr, 10))
      key.shift = mods.shift
      key.meta = mods.meta
      key.option = mods.option
      key.ctrl = mods.ctrl
      key.super = mods.super
    }
    if (raw.startsWith('\x1b\x1b')) {
      key.meta = true
      key.option = true
    }

    const codeKey = tildeFinal
      ? `${prefix}${num}${tildeFinal}`
      : `${prefix}${letterFinal}`
    key.name = KEY_NAME_MAP[codeKey] ?? ''
    key.fn = key.name.startsWith('f') && key.name.length >= 2
    if (tildeFinal === '^') key.ctrl = true
    if (tildeFinal === '$') key.shift = true
    return key
  }

  return key
}

function inputToString(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    if (input.length === 1 && input[0]! > 127) {
      return '\x1b' + String.fromCharCode(input[0]! - 128)
    }
    return input.toString('utf8')
  }
  return input
}

/**
 * Stateful streaming parser that converts arbitrary stdin chunks into typed
 * key, mouse, paste, focus, and terminal-response events.
 */
export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
): [ParsedInput[], KeyParseState] {
  const isFlush = input === null
  const inputString = isFlush ? '' : inputToString(input)
  const tokenizer = prevState._tokenizer ?? createTokenizer({ x10Mouse: true })
  const tokens = isFlush ? tokenizer.flush() : tokenizer.feed(inputString)

  const events: ParsedInput[] = []
  let inPaste = prevState.mode === 'IN_PASTE'
  let pasteBuffer = prevState.pasteBuffer

  for (const token of tokens) {
    if (token.type === 'sequence') {
      if (token.value === PASTE_START) {
        inPaste = true
        pasteBuffer = ''
      } else if (token.value === PASTE_END) {
        // Emit paste event even when pasteBuffer is empty (clipboard image read signal)
        events.push(createPasteKey(pasteBuffer))
        inPaste = false
        pasteBuffer = ''
      } else if (inPaste) {
        pasteBuffer += token.value
      } else if (token.value === FOCUS_IN) {
        events.push({ kind: 'focus', focused: true, raw: token.value })
      } else if (token.value === FOCUS_OUT) {
        events.push({ kind: 'focus', focused: false, raw: token.value })
      } else {
        const response = parseTerminalResponse(token.value)
        if (response) {
          events.push({ kind: 'response', sequence: token.value, response })
        } else {
          const mouse = parseMouseEvent(token.value)
          if (mouse) {
            events.push(mouse)
          } else {
            events.push(parseKeypress(token.value))
          }
        }
      }
    } else if (token.type === 'text') {
      if (inPaste) {
        pasteBuffer += token.value
      } else if (
        /^\[<\d+;\d+;\d+[Mm]$/.test(token.value) ||
        /^\[M[\x60-\x7f][\x20-\uffff]{2}$/.test(token.value)
      ) {
        const resynthesized = '\x1b' + token.value
        const mouse = parseMouseEvent(resynthesized)
        events.push(mouse ?? parseKeypress(resynthesized))
      } else {
        // Split regular text into individual key events (grapheme / codepoint level)
        for (const ch of token.value) {
          events.push(parseKeypress(ch))
        }
      }
    }
  }

  if (isFlush && inPaste) {
    events.push(createPasteKey(pasteBuffer))
    inPaste = false
    pasteBuffer = ''
  }

  return [
    events,
    {
      mode: inPaste ? 'IN_PASTE' : 'NORMAL',
      incomplete: tokenizer.buffer(),
      pasteBuffer,
      _tokenizer: tokenizer,
    },
  ]
}
