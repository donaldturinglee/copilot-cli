import React from 'react'
import { ThemedText } from './design_system/themed_text.js'

export function MessageModel({ model }: { model?: string }): React.ReactNode {
  if (!model) return null
  return <ThemedText dimColor>[{model}]</ThemedText>
}
