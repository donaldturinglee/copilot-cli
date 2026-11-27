import type { ParsedKey } from '../parse_keypress.js'
import { InkEvent } from './event.js'

export type Key = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageDown: boolean
  pageUp: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
  super: boolean
  fn: boolean
  wheelUp: boolean
  wheelDown: boolean
  isPasted?: boolean
  isEmptyPaste?: boolean
  name?: string
}

export function createEmptyKey(): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    fn: false,
    wheelUp: false,
    wheelDown: false,
  }
}

export function parsedKeyToKey(parsed: ParsedKey): { input: string; key: Key } {
  const key = createEmptyKey()
  key.upArrow = parsed.name === 'up'
  key.downArrow = parsed.name === 'down'
  key.leftArrow = parsed.name === 'left'
  key.rightArrow = parsed.name === 'right'
  key.pageDown = parsed.name === 'pagedown'
  key.pageUp = parsed.name === 'pageup'
  key.home = parsed.name === 'home'
  key.end = parsed.name === 'end'
  key.return = parsed.name === 'return' || parsed.name === 'enter'
  key.escape = parsed.name === 'escape'
  key.tab = parsed.name === 'tab'
  key.backspace = parsed.name === 'backspace'
  key.delete = parsed.name === 'delete'
  key.ctrl = parsed.ctrl
  key.shift = parsed.shift
  key.meta = parsed.meta || parsed.option
  key.super = parsed.super
  key.fn = parsed.fn
  key.isPasted = parsed.isPasted
  key.isEmptyPaste = parsed.isEmptyPaste
  key.name = parsed.name

  let input = ''
  if (parsed.isPasted) {
    input = parsed.sequence
  } else if (
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end ||
    key.return ||
    key.escape ||
    key.tab ||
    key.backspace ||
    key.delete ||
    key.fn
  ) {
    input = ''
  } else if (parsed.name === 'space') {
    input = ' '
  } else if (parsed.ctrl || parsed.meta || parsed.super) {
    input = parsed.name.length === 1 ? parsed.name : ''
  } else {
    input = parsed.sequence
  }

  return { input, key }
}

export class KeyboardEvent<TTarget = unknown> extends InkEvent<TTarget> {
  readonly input: string
  readonly key: Key

  constructor(
    type: 'keydown' | 'keyup' | 'keypress',
    input: string,
    key: Key,
  ) {
    super(type, { bubbles: true, cancelable: true })
    this.input = input
    this.key = key
  }
}
