import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React, { memo } from 'react'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from '../design_system/themed_text.js'
import { FilePathLink } from '../file_path_link.js'
import { ToolUseLoader } from '../tool_use_loader.js'
import { ToolResultMessageView } from './tool_result_message_view.js'

export type ToolUseMessageViewProps = {
  toolName: string
  toolUseId: string
  input: unknown
  result?: ToolResultBlockParam
  isResolved: boolean
  isError: boolean
  verbose?: boolean
  width?: number
}

function summarizeToolInput(toolName: string, input: unknown): {
  summary: string
  filePath?: string
} {
  if (!input || typeof input !== 'object') {
    return { summary: '' }
  }
  const obj = input as Record<string, unknown>
  if (typeof obj.file_path === 'string') {
    return { summary: obj.file_path, filePath: obj.file_path }
  }
  if (typeof obj.notebook_path === 'string') {
    return { summary: obj.notebook_path, filePath: obj.notebook_path }
  }
  if (typeof obj.command === 'string') {
    const firstLine = obj.command.split('\n')[0] ?? ''
    const trimmed =
      firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine
    return { summary: trimmed }
  }
  if (typeof obj.pattern === 'string') {
    const dir = typeof obj.path === 'string' ? ` in ${obj.path}` : ''
    return { summary: `${obj.pattern}${dir}` }
  }
  if (typeof obj.url === 'string') {
    return { summary: obj.url }
  }
  if (typeof obj.query === 'string') {
    return { summary: obj.query }
  }
  const keys = Object.keys(obj)
  if (keys.length === 0) return { summary: '' }
  const firstVal = obj[keys[0]!]
  const preview =
    typeof firstVal === 'string'
      ? firstVal.slice(0, 60)
      : JSON.stringify(firstVal)?.slice(0, 60) ?? ''
  return { summary: `${toolName ? '' : ''}${keys[0]}: ${preview}` }
}

export const ToolUseMessageView = memo(function ToolUseMessageView({
  toolName,
  input,
  result,
  isResolved,
  isError,
  verbose = false,
  width = 76,
}: ToolUseMessageViewProps): React.ReactNode {
  const { summary, filePath } = summarizeToolInput(toolName, input)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <ToolUseLoader
          isError={isError}
          isUnresolved={!isResolved}
          shouldAnimate={!isResolved}
        />
        <ThemedText bold>{toolName}</ThemedText>
        {summary ? (
          <Box flexDirection="row">
            <ThemedText dimColor>(</ThemedText>
            {filePath ? (
              <FilePathLink filePath={filePath} />
            ) : (
              <ThemedText dimColor wrap="truncate-end">
                {summary}
              </ThemedText>
            )}
            <ThemedText dimColor>)</ThemedText>
          </Box>
        ) : null}
      </Box>
      {result ? (
        <ToolResultMessageView
          toolName={toolName}
          input={input}
          result={result}
          verbose={verbose}
          width={width}
        />
      ) : null}
    </Box>
  )
})
