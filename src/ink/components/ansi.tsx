import React from 'react'
import { Text } from './text.js'

export type AnsiProps = {
  children?: string
  dimColor?: boolean
}

export function Ansi({ children, dimColor }: AnsiProps): React.ReactNode {
  if (!children) return null
  return <Text dimColor={dimColor}>{children}</Text>
}
