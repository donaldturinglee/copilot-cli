import React from 'react'
import type { ColorValue } from '../../ink/styles.js'
import { ThemedBox, type ThemedBoxProps } from './themed_box.js'
import { ThemedText } from './themed_text.js'

export type PaneProps = ThemedBoxProps & {
  title?: string
  subtitle?: string
  titleColor?: ColorValue
}

export function Pane({
  title,
  subtitle,
  titleColor = 'claude',
  borderStyle = 'round',
  borderColor = 'promptBorder',
  paddingX = 1,
  children,
  ...rest
}: PaneProps): React.ReactNode {
  return (
    <ThemedBox
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      paddingX={paddingX}
      {...rest}
    >
      {title ? (
        <ThemedBox flexDirection="row" gap={1} marginBottom={1}>
          <ThemedText bold color={titleColor}>
            {title}
          </ThemedText>
          {subtitle ? <ThemedText dimColor>{subtitle}</ThemedText> : null}
        </ThemedBox>
      ) : null}
      {children}
    </ThemedBox>
  )
}
