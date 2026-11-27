import React, { memo } from 'react'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import type { AssistantMessage } from '../../types/message.js'
import type { ToolResultLookup } from '../../utilities/group_tool_uses.js'
import { ThemedText } from '../design_system/themed_text.js'
import { Markdown, StreamingMarkdown } from '../markdown.js'
import { MessageModel } from '../message_model.js'
import { MessageTimestamp } from '../message_timestamp.js'
import { ThinkingMessageView } from './thinking_message_view.js'
import { ToolUseMessageView } from './tool_use_message_view.js'

export type AssistantMessageViewProps = {
  message: AssistantMessage
  toolResults: ToolResultLookup
  width?: number
  isStreaming?: boolean
  verbose?: boolean
  showModel?: boolean
  showTimestamp?: boolean
}

export const AssistantMessageView = memo(function AssistantMessageView({
  message,
  toolResults,
  width = 80,
  isStreaming = false,
  verbose = false,
  showModel = false,
  showTimestamp = false,
}: AssistantMessageViewProps): React.ReactNode {
  if (message.isMeta) return null

  const content = message.message.content
  if (!Array.isArray(content) || content.length === 0) return null

  const contentWidth = Math.max(20, width - 4)

  return (
    <Box flexDirection="column" marginTop={1} gap={0}>
      {content.map((block, idx) => {
        if (block.type === 'thinking') {
          return (
            <ThinkingMessageView
              key={`thinking-${idx}`}
              thinking={block.thinking}
              verbose={verbose}
            />
          )
        }

        if (block.type === 'text') {
          const text = block.text
          if (!text.trim()) return null
          return (
            <Box key={`text-${idx}`} flexDirection="row" gap={1}>
              <ThemedText color={message.isApiErrorMessage ? 'error' : 'text'}>
                {BLACK_CIRCLE}
              </ThemedText>
              <Box flexDirection="column" flexGrow={1}>
                {message.isApiErrorMessage ? (
                  <ThemedText color="error">{text}</ThemedText>
                ) : isStreaming ? (
                  <StreamingMarkdown width={contentWidth} isStreaming={true}>
                    {text}
                  </StreamingMarkdown>
                ) : (
                  <Markdown width={contentWidth}>{text}</Markdown>
                )}
              </Box>
            </Box>
          )
        }

        if (block.type === 'tool_use') {
          const result = toolResults.resultsById.get(block.id)
          const isResolved = toolResults.resolvedIds.has(block.id)
          const isError = toolResults.erroredIds.has(block.id)
          return (
            <ToolUseMessageView
              key={block.id || `tool-${idx}`}
              toolName={block.name}
              toolUseId={block.id}
              input={block.input}
              result={result}
              isResolved={isResolved}
              isError={isError}
              verbose={verbose}
              width={contentWidth}
            />
          )
        }

        return null
      })}

      {showModel || showTimestamp ? (
        <Box flexDirection="row" gap={1} marginLeft={2}>
          {showModel ? <MessageModel model={message.message.model} /> : null}
          {showTimestamp ? (
            <MessageTimestamp timestamp={message.timestamp} />
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
})
