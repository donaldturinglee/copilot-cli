import React from 'react'
import { ThemedText } from './design_system/themed_text.js'

export type ClickableImageRefProps = {
  id: number
  label?: string
}

export function ClickableImageRef({
  id,
  label,
}: ClickableImageRefProps): React.ReactNode {
  return (
    <ThemedText color="suggestion" bold>
      {label ?? `[Image #${id}]`}
    </ThemedText>
  )
}
