import React from 'react'
import { useRegisterOverlay } from '../../context/overlay_context.js'
import { Box } from '../../ink/components/box.js'
import { useKeybinding } from '../../keybindings/use_keybinding.js'
import type { ColorValue } from '../../ink/styles.js'
import { Divider } from './divider.js'
import { KeyboardShortcutHint } from './keyboard_shortcut_hint.js'
import { ThemedBox } from './themed_box.js'
import { ThemedText } from './themed_text.js'

export type DialogProps = {
  title: string
  subtitle?: string
  borderColor?: ColorValue
  onCancel?: () => void
  footer?: React.ReactNode
  width?: number
  overlayId?: string
  children: React.ReactNode
}

export function Dialog({
  title,
  subtitle,
  borderColor = 'permission',
  onCancel,
  footer,
  width,
  overlayId = 'dialog',
  children,
}: DialogProps): React.ReactNode {
  useRegisterOverlay(overlayId, true)
  useKeybinding(
    'confirm:no',
    () => {
      onCancel?.()
    },
    { context: 'Confirmation', isActive: Boolean(onCancel) },
  )

  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={width}
    >
      <Box flexDirection="column" marginBottom={1}>
        <ThemedText bold color={borderColor}>
          {title}
        </ThemedText>
        {subtitle ? <ThemedText dimColor>{subtitle}</ThemedText> : null}
      </Box>
      <Box flexDirection="column">{children}</Box>
      {footer !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Divider width={Math.max(16, (width ?? 60) - 4)} />
          <Box marginTop={0}>{footer}</Box>
        </Box>
      ) : onCancel ? (
        <Box marginTop={1}>
          <KeyboardShortcutHint shortcut="escape" action="to cancel" />
        </Box>
      ) : null}
    </ThemedBox>
  )
}
