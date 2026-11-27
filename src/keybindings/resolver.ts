import type { Key } from '../ink/events/keyboard_event.js'
import { getKeyName, matchesBinding } from './match.js'
import { chordToString } from './parser.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'

export type ResolveResult =
  | { type: 'match'; action: string }
  | { type: 'none' }
  | { type: 'unbound' }

export type ChordResolveResult =
  | { type: 'match'; action: string }
  | { type: 'none' }
  | { type: 'unbound' }
  | { type: 'chord_started'; pending: ParsedKeystroke[] }
  | { type: 'chord_cancelled' }

export function resolveKey(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  let match: ParsedBinding | undefined
  const ctxSet = new Set(activeContexts)

  for (const binding of bindings) {
    if (binding.chord.length !== 1) continue
    if (!ctxSet.has(binding.context)) continue
    if (matchesBinding(input, key, binding)) {
      match = binding
    }
  }

  if (!match) return { type: 'none' }
  if (match.action === null) return { type: 'unbound' }
  return { type: 'match', action: match.action }
}

export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
): string | undefined {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i]!
    if (b.action === action && b.context === context) {
      return chordToString(b.chord)
    }
  }
  return undefined
}

function buildKeystroke(input: string, key: Key): ParsedKeystroke | null {
  const keyName = getKeyName(input, key)
  if (!keyName) return null
  const effectiveMeta = key.escape ? false : key.meta
  return {
    key: keyName,
    ctrl: key.ctrl,
    alt: effectiveMeta,
    shift: key.shift,
    meta: effectiveMeta,
    super: key.super,
  }
}

export function keystrokesEqual(
  a: ParsedKeystroke,
  b: ParsedKeystroke,
): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    (a.alt || a.meta) === (b.alt || b.meta) &&
    a.super === b.super
  )
}

function chordPrefixMatches(
  prefix: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (prefix.length >= binding.chord.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (!keystrokesEqual(prefix[i]!, binding.chord[i]!)) return false
  }
  return true
}

function chordExactlyMatches(
  chord: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (chord.length !== binding.chord.length) return false
  for (let i = 0; i < chord.length; i++) {
    if (!keystrokesEqual(chord[i]!, binding.chord[i]!)) return false
  }
  return true
}

/**
 * Resolve a single key input against active contexts and any pending chord prefix.
 */
export function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  if (key.escape && pending !== null) {
    return { type: 'chord_cancelled' }
  }

  const currentKeystroke = buildKeystroke(input, key)
  if (!currentKeystroke) {
    return pending !== null ? { type: 'chord_cancelled' } : { type: 'none' }
  }

  const testChord = pending
    ? [...pending, currentKeystroke]
    : [currentKeystroke]

  const ctxSet = new Set(activeContexts)
  const contextBindings = bindings.filter(b => ctxSet.has(b.context))

  // Check if any non-unbound longer chord shares this prefix
  const chordWinners = new Map<string, string | null>()
  for (const binding of contextBindings) {
    if (
      binding.chord.length > testChord.length &&
      chordPrefixMatches(testChord, binding)
    ) {
      chordWinners.set(chordToString(binding.chord), binding.action)
    }
  }
  let hasLongerChords = false
  for (const action of chordWinners.values()) {
    if (action !== null) {
      hasLongerChords = true
      break
    }
  }

  if (hasLongerChords) {
    return { type: 'chord_started', pending: testChord }
  }

  // Exact match: context priority follows activeContexts order (specific before Global),
  // with later user bindings overriding earlier defaults within the same context.
  let exactMatch: ParsedBinding | undefined
  for (const ctx of activeContexts) {
    let ctxMatch: ParsedBinding | undefined
    for (const binding of contextBindings) {
      if (binding.context !== ctx) continue
      if (chordExactlyMatches(testChord, binding)) {
        ctxMatch = binding
      }
    }
    if (ctxMatch) {
      exactMatch = ctxMatch
      break
    }
  }

  if (exactMatch) {
    if (exactMatch.action === null) {
      return { type: 'unbound' }
    }
    return { type: 'match', action: exactMatch.action }
  }

  if (pending !== null) {
    return { type: 'chord_cancelled' }
  }

  return { type: 'none' }
}
