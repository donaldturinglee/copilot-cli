import React from 'react'
import { Box, type BoxProps } from '../../ink/components/box.js'
import type { ColorValue } from '../../ink/styles.js'
import { resolveThemeColor } from './color.js'
import { useTheme } from './theme_provider.js'

export type ThemedBoxProps = BoxProps

export function ThemedBox({
  borderColor,
  backgroundColor,
  children,
  ...rest
}: ThemedBoxProps): React.ReactNode {
  const [themeName] = useTheme()
  return (
    <Box
      {...rest}
      borderColor={resolveThemeColor(borderColor, themeName) as ColorValue}
      backgroundColor={resolveThemeColor(backgroundColor, themeName) as ColorValue}
    >
      {children}
    </Box>
  )
}
