import React from 'react'
import { Text } from './text.js'

export type LinkProps = {
  url: string
  children?: React.ReactNode
}

export function Link({ url, children }: LinkProps): React.ReactNode {
  return (
    <Text underline>
      {React.createElement('ink-link', { href: url }, children ?? url)}
    </Text>
  )
}
