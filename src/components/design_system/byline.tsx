import React from 'react'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from './themed_text.js'

export type BylineProps = {
  children: React.ReactNode
  separator?: string
}

export function Byline({
  children,
  separator = ' · ',
}: BylineProps): React.ReactNode {
  const items = React.Children.toArray(children)
  if (items.length === 0) return null

  return (
    <Box flexDirection="row" flexWrap="wrap">
      {items.map((item, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 ? <ThemedText dimColor>{separator}</ThemedText> : null}
          {item}
        </React.Fragment>
      ))}
    </Box>
  )
}
