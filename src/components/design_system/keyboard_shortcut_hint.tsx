import React from 'react'
import { Text } from '../../ink/components/text.js'
import { formatShortcutHint } from '../../utilities/keyboard_shortcuts.js'

export type KeyboardShortcutHintProps = {
  shortcut: string
  action: string
  parens?: boolean
  bold?: boolean
}

export function KeyboardShortcutHint({
  shortcut,
  action,
  parens = false,
  bold = false,
}: KeyboardShortcutHintProps): React.ReactNode {
  const formatted = formatShortcutHint(shortcut)
  const content = `${formatted} ${action}`
  return (
    <Text dimColor bold={bold}>
      {parens ? `(${content})` : content}
    </Text>
  )
}
