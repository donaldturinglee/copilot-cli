import React, { memo } from 'react'
import { ThemedText } from './design_system/themed_text.js'
import { MessageResponse } from './message_response.js'

export type FallbackToolUseRejectedMessageProps = {
  toolName?: string
  reason?: string
}

export const FallbackToolUseRejectedMessage = memo(
  function FallbackToolUseRejectedMessage({
    toolName,
    reason,
  }: FallbackToolUseRejectedMessageProps): React.ReactNode {
    return (
      <MessageResponse>
        <ThemedText color="error">
          {toolName
            ? `User rejected ${toolName} tool call`
            : 'User rejected tool call'}
          {reason ? `: ${reason}` : ''}
        </ThemedText>
      </MessageResponse>
    )
  },
)
