import { formatShortcutHint } from '../utilities/keyboard_shortcuts.js'
import { chordToString } from './parser.js'
import type { ParsedKeystroke } from './types.js'

export function formatChordForDisplay(
  chord: readonly ParsedKeystroke[],
): string {
  return formatShortcutHint(chordToString(chord))
}

export function formatKeybindingString(shortcut: string): string {
  return formatShortcutHint(shortcut)
}
