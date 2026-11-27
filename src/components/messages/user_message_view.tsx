import React, { memo } from 'react'
import { Box } from '../../ink/components/box.js'
import type { UserMessage } from '../../types/message.js'
import { parseDisplayTags } from '../../utilities/display_tags.js'
import { ClickableImageRef } from '../clickable_image_ref.js'
import { CompactSummary } from '../compact_summary.js'
import { ThemedBox } from '../design_system/themed_box.js'
import { ThemedText } from '../design_system/themed_text.js'
import { MessageResponse } from '../message_response.js'
import { MessageTimestamp } from '../message_timestamp.js'

export type UserMessageViewProps = {
  message: UserMessage
  width?: number
  showTimestamp?: boolean
  isHighlighted?: boolean
  verbose?: boolean
}

function extractUserTextParts(message: UserMessage): {
  text: string
  imageCount: number
  hasOnlyToolResults: boolean
} {
  const content = message.message.content
  if (typeof content === 'string') {
    return { text: content, imageCount: 0, hasOnlyToolResults: false }
  }
  if (!Array.isArray(content) || content.length === 0) {
    return { text: '', imageCount: 0, hasOnlyToolResults: false }
  }
  let imageCount = 0
  let nonToolResult = false
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      nonToolResult = true
      texts.push(block.text)
    } else if (block.type === 'image') {
      nonToolResult = true
      imageCount++
    }
  }
  return {
    text: texts.join('\n'),
    imageCount,
    hasOnlyToolResults: !nonToolResult,
  }
}

export const UserMessageView = memo(function UserMessageView({
  message,
  width = 80,
  showTimestamp = false,
  isHighlighted = false,
}: UserMessageViewProps): React.ReactNode {
  if (message.isMeta) return null

  if (message.isCompactSummary) {
    const raw =
      typeof message.message.content === 'string'
        ? message.message.content
        : ''
    return (
      <CompactSummary
        messagesSummarized={message.summarizeMetadata?.messagesSummarized}
        summaryText={raw.slice(0, 240)}
        width={Math.min(width, 72)}
      />
    )
  }

  const { text, imageCount, hasOnlyToolResults } = extractUserTextParts(message)
  if (hasOnlyToolResults) return null

  const parsed = parseDisplayTags(text)
  const hasVisibleOutput =
    Boolean(parsed.plainText) ||
    Boolean(parsed.commandName) ||
    Boolean(parsed.localStdout) ||
    Boolean(parsed.bashStdout) ||
    Boolean(parsed.bashStderr) ||
    imageCount > 0

  if (!hasVisibleOutput) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      {parsed.plainText || parsed.commandName || imageCount > 0 ? (
        <ThemedBox
          paddingX={1}
          backgroundColor={
            isHighlighted ? 'warning' : 'userMessageBackground'
          }
          flexDirection="row"
          justifyContent="space-between"
        >
          <Box flexDirection="row" gap={1} flexShrink={1}>
            <ThemedText color="claude" bold>
              ❯
            </ThemedText>
            <Box flexDirection="column" flexShrink={1}>
              {parsed.commandName ? (
                <ThemedText color="suggestion" bold>
                  {parsed.commandName}
                </ThemedText>
              ) : null}
              {parsed.plainText ? (
                <ThemedText>{parsed.plainText}</ThemedText>
              ) : null}
              {imageCount > 0 ? (
                <Box flexDirection="row" gap={1}>
                  {(message.imagePasteIds && message.imagePasteIds.length > 0
                    ? message.imagePasteIds
                    : Array.from({ length: imageCount }, (_, i) => i + 1)
                  ).map(id => (
                    <ClickableImageRef key={id} id={id} />
                  ))}
                </Box>
              ) : null}
            </Box>
          </Box>
          {showTimestamp ? (
            <MessageTimestamp timestamp={message.timestamp} />
          ) : null}
        </ThemedBox>
      ) : null}

      {parsed.localStdout ? (
        <MessageResponse>
          <ThemedText>{parsed.localStdout.trimEnd()}</ThemedText>
        </MessageResponse>
      ) : null}

      {parsed.bashStdout ? (
        <MessageResponse>
          <ThemedText>{parsed.bashStdout.trimEnd()}</ThemedText>
        </MessageResponse>
      ) : null}

      {parsed.bashStderr ? (
        <MessageResponse>
          <ThemedText color="error">{parsed.bashStderr.trimEnd()}</ThemedText>
        </MessageResponse>
      ) : null}
    </Box>
  )
})
