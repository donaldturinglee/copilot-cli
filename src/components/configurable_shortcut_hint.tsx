import React from 'react'
import { Text } from '../ink/components/text.js'
import type { KeybindingContextName } from '../keybindings/types.js'
import { useShortcutDisplay } from '../keybindings/use_shortcut_display.js'

export type ConfigurableShortcutHintProps = {
  action: string
  context: KeybindingContextName
  fallback: string
  description: string
  parens?: boolean
  dimColor?: boolean
}

export function ConfigurableShortcutHint({
  action,
  context,
  fallback,
  description,
  parens = false,
  dimColor = true,
}: ConfigurableShortcutHintProps): React.ReactNode {
  const display = useShortcutDisplay(action, context, fallback)
  const content = `${display} ${description}`
  return <Text dimColor={dimColor}>{parens ? `(${content})` : content}</Text>
}
