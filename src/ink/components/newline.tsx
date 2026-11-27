import React from 'react'
import { Text } from './text.js'

export type NewlineProps = {
  count?: number
}

export function Newline({ count = 1 }: NewlineProps): React.ReactNode {
  return <Text>{'\n'.repeat(Math.max(1, count))}</Text>
}
