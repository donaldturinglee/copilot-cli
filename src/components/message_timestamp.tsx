import React from 'react'
import { ThemedText } from './design_system/themed_text.js'

export function MessageTimestamp({
  timestamp,
}: {
  timestamp?: string
}): React.ReactNode {
  if (!timestamp) return null
  const date = new Date(timestamp)
  const label = isNaN(date.getTime())
    ? timestamp
    : date.toTimeString().slice(0, 8)
  return <ThemedText dimColor>{label}</ThemedText>
}
