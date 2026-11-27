import React, { memo } from 'react'
import { ThemedText } from './design_system/themed_text.js'
import { MessageResponse } from './message_response.js'

export type FallbackToolUseErrorMessageProps = {
  message: string
}

export const FallbackToolUseErrorMessage = memo(
  function FallbackToolUseErrorMessage({
    message,
  }: FallbackToolUseErrorMessageProps): React.ReactNode {
    return (
      <MessageResponse>
        <ThemedText color="error">{message}</ThemedText>
      </MessageResponse>
    )
  },
)
