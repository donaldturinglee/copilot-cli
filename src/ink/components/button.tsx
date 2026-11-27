import React from 'react'
import type { ClickEvent } from '../events/click_event.js'
import type { KeyboardEvent } from '../events/keyboard_event.js'
import { Box, type BoxProps } from './box.js'

export type ButtonProps = Omit<BoxProps, 'onClick'> & {
  onPress?: () => void
  onClick?: (event: ClickEvent) => void
  disabled?: boolean
}

export function Button({
  onPress,
  onClick,
  disabled = false,
  tabIndex = 0,
  children,
  ...boxProps
}: ButtonProps): React.ReactNode {
  const handleClick = (event: ClickEvent): void => {
    if (disabled) return
    onClick?.(event)
    if (!event.defaultPrevented) {
      onPress?.()
    }
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (disabled) return
    if (event.key.return || event.input === ' ') {
      onPress?.()
      event.stopPropagation()
    }
  }

  return (
    <Box
      {...boxProps}
      tabIndex={disabled ? undefined : tabIndex}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </Box>
  )
}
