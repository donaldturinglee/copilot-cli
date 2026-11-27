import { parseChord } from './parser.js'
import {
  getReservedShortcuts,
  normalizeKeyForComparison,
} from './reserved_shortcuts.js'
import {
  KEYBINDING_CONTEXTS,
  type KeybindingBlock,
  type KeybindingContextName,
} from './types.js'

export type KeybindingWarning = {
  type:
    | 'parse_error'
    | 'invalid_context'
    | 'invalid_key'
    | 'reserved_shortcut'
    | 'duplicate_key'
  severity: 'error' | 'warning'
  message: string
  context?: string
  key?: string
}

const VALID_CONTEXT_SET = new Set<string>(KEYBINDING_CONTEXTS)

export function validateUserKeybindingBlocks(
  blocks: readonly KeybindingBlock[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const reserved = getReservedShortcuts()
  const reservedMap = new Map(
    reserved.map(r => [normalizeKeyForComparison(r.key), r]),
  )

  const seenPerContext = new Map<KeybindingContextName, Set<string>>()

  for (const block of blocks) {
    if (!VALID_CONTEXT_SET.has(block.context)) {
      warnings.push({
        type: 'invalid_context',
        severity: 'error',
        message: `Unknown keybinding context "${String(block.context)}"`,
        context: String(block.context),
      })
      continue
    }

    let seen = seenPerContext.get(block.context)
    if (!seen) {
      seen = new Set()
      seenPerContext.set(block.context, seen)
    }

    for (const [rawKey, action] of Object.entries(block.bindings)) {
      const chord = parseChord(rawKey)
      if (!chord) {
        warnings.push({
          type: 'invalid_key',
          severity: 'error',
          message: `Invalid keybinding syntax "${rawKey}" in context "${block.context}"`,
          context: block.context,
          key: rawKey,
        })
        continue
      }

      const normalized = normalizeKeyForComparison(rawKey)
      const firstStep = normalized.split(' ')[0] ?? normalized
      const reservedHit =
        reservedMap.get(normalized) ??
        (chord.length === 1 ? reservedMap.get(firstStep) : undefined)

      if (reservedHit && action !== null) {
        warnings.push({
          type: 'reserved_shortcut',
          severity: reservedHit.severity,
          message: `Shortcut "${rawKey}" in "${block.context}": ${reservedHit.reason}`,
          context: block.context,
          key: rawKey,
        })
      }

      if (seen.has(normalized)) {
        warnings.push({
          type: 'duplicate_key',
          severity: 'warning',
          message: `Duplicate keybinding "${rawKey}" in context "${block.context}"`,
          context: block.context,
          key: rawKey,
        })
      } else {
        seen.add(normalized)
      }
    }
  }

  return warnings
}
