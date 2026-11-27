import React from 'react'
import { Text, type TextProps } from '../../ink/components/text.js'
import type { ColorValue } from '../../ink/styles.js'
import { resolveThemeColor } from './color.js'
import { useTheme } from './theme_provider.js'

export type ThemedTextProps = TextProps

export function ThemedText({
  color,
  backgroundColor,
  children,
  ...rest
}: ThemedTextProps): React.ReactNode {
  const [themeName] = useTheme()
  return (
    <Text
      {...rest}
      color={resolveThemeColor(color, themeName) as ColorValue}
      backgroundColor={resolveThemeColor(backgroundColor, themeName) as ColorValue}
    >
      {children}
    </Text>
  )
}
