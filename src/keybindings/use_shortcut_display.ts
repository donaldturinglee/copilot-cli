import { useOptionalKeybindingContext } from './keybinding_context.js'
import { formatKeybindingString } from './shortcut_format.js'
import type { KeybindingContextName } from './types.js'

export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback?: string,
): string {
  const ctx = useOptionalKeybindingContext()
  const raw = ctx?.getDisplayText(action, context) ?? fallback
  return raw ? formatKeybindingString(raw) : ''
}
