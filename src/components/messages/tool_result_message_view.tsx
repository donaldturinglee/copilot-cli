import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React, { memo } from 'react'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from '../design_system/themed_text.js'
import { FallbackToolUseErrorMessage } from '../fallback_tool_use_error_message.js'
import { FallbackToolUseRejectedMessage } from '../fallback_tool_use_rejected_message.js'
import { FileEditToolUpdatedMessage } from '../file_edit_tool_updated_message.js'
import { FileEditToolUseRejectedMessage } from '../file_edit_tool_use_rejected_message.js'
import { MessageResponse } from '../message_response.js'
import { NotebookEditToolUseRejectedMessage } from '../notebook_edit_tool_use_rejected_message.js'

export type ToolResultMessageViewProps = {
  toolName: string
  input: unknown
  result: ToolResultBlockParam
  verbose?: boolean
  width?: number
}

const DEFAULT_MAX_LINES = 6

function extractResultText(result: ToolResultBlockParam): string {
  if (typeof result.content === 'string') return result.content
  if (Array.isArray(result.content)) {
    return result.content
      .map(block => (block.type === 'text' ? block.text : '[image]'))
      .join('\n')
  }
  return ''
}

export const ToolResultMessageView = memo(function ToolResultMessageView({
  toolName,
  input,
  result,
  verbose = false,
  width = 76,
}: ToolResultMessageViewProps): React.ReactNode {
  const text = extractResultText(result).trimEnd()
  const obj =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : null

  if (result.is_error) {
    const isRejected =
      text.toLowerCase().includes('rejected') ||
      text.toLowerCase().includes('denied') ||
      text.toLowerCase().includes('declined')

    if (isRejected) {
      if (
        (toolName === 'Edit' || toolName === 'FileEdit') &&
        typeof obj?.file_path === 'string'
      ) {
        return (
          <FileEditToolUseRejectedMessage
            filePath={obj.file_path}
            oldString={typeof obj.old_string === 'string' ? obj.old_string : ''}
            newString={typeof obj.new_string === 'string' ? obj.new_string : ''}
            reason={text}
            width={width}
          />
        )
      }
      if (
        toolName === 'NotebookEdit' &&
        typeof obj?.notebook_path === 'string'
      ) {
        return (
          <NotebookEditToolUseRejectedMessage
            notebookPath={obj.notebook_path}
            cellId={typeof obj.cell_id === 'string' ? obj.cell_id : undefined}
            reason={text}
          />
        )
      }
      return (
        <FallbackToolUseRejectedMessage toolName={toolName} reason={text} />
      )
    }

    return <FallbackToolUseErrorMessage message={text || 'Tool failed'} />
  }

  // Successful FileEdit: show structured diff preview
  if (
    (toolName === 'Edit' || toolName === 'FileEdit') &&
    typeof obj?.file_path === 'string' &&
    typeof obj.old_string === 'string' &&
    typeof obj.new_string === 'string'
  ) {
    return (
      <FileEditToolUpdatedMessage
        filePath={obj.file_path}
        oldString={obj.old_string}
        newString={obj.new_string}
        width={width}
      />
    )
  }

  if (!text) {
    return (
      <MessageResponse>
        <ThemedText dimColor>(No output)</ThemedText>
      </MessageResponse>
    )
  }

  const lines = text.split('\n')
  const limit = verbose ? lines.length : DEFAULT_MAX_LINES
  const visible = lines.slice(0, limit)
  const hiddenCount = lines.length - visible.length

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <ThemedText key={i} dimColor={!verbose}>
            {line}
          </ThemedText>
        ))}
        {hiddenCount > 0 ? (
          <ThemedText dimColor>
            … +{hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'} (Ctrl+O
            to expand)
          </ThemedText>
        ) : null}
      </Box>
    </MessageResponse>
  )
})
