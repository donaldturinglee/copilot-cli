import type { Key } from '../ink/events/keyboard_event.js'
import type { ParsedBinding, ParsedKeystroke } from './types.js'

export function getKeyName(input: string, key: Key): string | null {
  if (key.escape) return 'escape'
  if (key.return) return 'enter'
  if (key.tab) return 'tab'
  if (key.backspace) return 'backspace'
  if (key.delete) return 'delete'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.pageUp) return 'pageup'
  if (key.pageDown) return 'pagedown'
  if (key.home) return 'home'
  if (key.end) return 'end'
  if (key.wheelUp) return 'wheelup'
  if (key.wheelDown) return 'wheeldown'
  if (input === ' ') return 'space'
  if (key.name && key.name.length > 0) {
    return key.name === 'return' ? 'enter' : key.name.toLowerCase()
  }
  if (input.length === 1) {
    return input.toLowerCase()
  }
  return null
}

export function matchesKeystroke(
  input: string,
  key: Key,
  target: ParsedKeystroke,
): boolean {
  const actualKey = getKeyName(input, key)
  if (!actualKey || actualKey !== target.key) return false

  const effectiveMeta = key.escape ? false : key.meta
  const targetMeta = target.alt || target.meta

  return (
    key.ctrl === target.ctrl &&
    key.shift === target.shift &&
    effectiveMeta === targetMeta &&
    key.super === target.super
  )
}

export function matchesBinding(
  input: string,
  key: Key,
  binding: ParsedBinding,
): boolean {
  if (binding.chord.length !== 1) return false
  return matchesKeystroke(input, key, binding.chord[0]!)
}
