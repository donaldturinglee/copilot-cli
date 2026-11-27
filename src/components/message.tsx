import React, { memo } from 'react'
import type { Message } from '../types/message.js'
import type { ToolResultLookup } from '../utilities/group_tool_uses.js'
import { AssistantMessageView } from './messages/assistant_message_view.js'
import { ProgressMessageView } from './messages/progress_message_view.js'
import { SystemMessageView } from './messages/system_message_view.js'
import { UserMessageView } from './messages/user_message_view.js'

export type MessageViewProps = {
  message: Message
  toolResults: ToolResultLookup
  width?: number
  isStreaming?: boolean
  verbose?: boolean
  showTimestamps?: boolean
  showModel?: boolean
  isHighlighted?: boolean
}

export const MessageView = memo(function MessageView({
  message,
  toolResults,
  width = 80,
  isStreaming = false,
  verbose = false,
  showTimestamps = false,
  showModel = false,
  isHighlighted = false,
}: MessageViewProps): React.ReactNode {
  switch (message.type) {
    case 'user':
      return (
        <UserMessageView
          message={message}
          width={width}
          showTimestamp={showTimestamps}
          isHighlighted={isHighlighted}
          verbose={verbose}
        />
      )
    case 'assistant':
      return (
        <AssistantMessageView
          message={message}
          toolResults={toolResults}
          width={width}
          isStreaming={isStreaming}
          verbose={verbose}
          showModel={showModel}
          showTimestamp={showTimestamps}
        />
      )
    case 'system':
      return (
        <SystemMessageView
          message={message}
          width={width}
          verbose={verbose}
        />
      )
    case 'progress':
      return <ProgressMessageView message={message} />
    case 'attachment':
      return null
  }
})
