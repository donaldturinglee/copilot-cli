import type {
  KeybindingBlock,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  cr: 'enter',
  bs: 'backspace',
  del: 'delete',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
  spc: 'space',
  ' ': 'space',
}

export function parseKeystroke(raw: string): ParsedKeystroke | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const parts = trimmed.split('+').map(p => p.trim())
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  let superKey = false
  let mainKey = ''

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const lower = part.toLowerCase()
    if (i < parts.length - 1 || ['ctrl', 'control', 'alt', 'opt', 'option', 'meta', 'shift', 'cmd', 'command', 'super'].includes(lower)) {
      if (lower === 'ctrl' || lower === 'control') {
        ctrl = true
        continue
      }
      if (lower === 'alt' || lower === 'opt' || lower === 'option') {
        alt = true
        meta = true
        continue
      }
      if (lower === 'meta') {
        meta = true
        alt = true
        continue
      }
      if (lower === 'shift') {
        shift = true
        continue
      }
      if (lower === 'cmd' || lower === 'command' || lower === 'super') {
        superKey = true
        continue
      }
    }
    mainKey = KEY_ALIASES[lower] ?? lower
  }

  if (!mainKey) return null

  return {
    key: mainKey,
    ctrl,
    alt,
    shift,
    meta,
    super: superKey,
  }
}

export function parseChord(raw: string): ParsedKeystroke[] | null {
  const steps = raw.trim().split(/\s+/).filter(Boolean)
  if (steps.length === 0) return null
  const chord: ParsedKeystroke[] = []
  for (const step of steps) {
    const parsed = parseKeystroke(step)
    if (!parsed) return null
    chord.push(parsed)
  }
  return chord
}

export function parseBindings(
  blocks: readonly KeybindingBlock[],
  source: 'default' | 'user' = 'default',
): ParsedBinding[] {
  const result: ParsedBinding[] = []
  for (const block of blocks) {
    for (const [rawKey, action] of Object.entries(block.bindings)) {
      const chord = parseChord(rawKey)
      if (!chord) continue
      result.push({
        chord,
        action,
        context: block.context,
        source,
        rawKey,
      })
    }
  }
  return result
}

export function keystrokeToString(ks: ParsedKeystroke): string {
  const parts: string[] = []
  if (ks.ctrl) parts.push('ctrl')
  if (ks.super) parts.push('cmd')
  if (ks.alt || ks.meta) parts.push('meta')
  if (ks.shift) parts.push('shift')
  parts.push(ks.key)
  return parts.join('+')
}

export function chordToString(chord: readonly ParsedKeystroke[]): string {
  return chord.map(keystrokeToString).join(' ')
}
