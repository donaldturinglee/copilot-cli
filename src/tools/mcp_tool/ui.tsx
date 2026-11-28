/**
 * Ink TUI rendering hooks for `MCPTool` invocations, live progress bars, and
 * large-token result warnings.
 */

import React from 'react'
import { ProgressBar } from '../../components/design_system/progress_bar.js'
import { ThemedText } from '../../components/design_system/themed_text.js'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import type { ProgressMessage } from '../../types/message.js'
import type { McpProgress } from '../../types/tools.js'
import type { McpToolInput, McpToolOutput } from './mcp_tool.js'

const LARGE_TOKEN_WARNING_CHARS = 40_000 // ~10,000 tokens

/**
 * Renders the compact parameter preview for an MCP tool call.
 */
export function renderMcpToolUseMessage(
  input: Partial<McpToolInput>,
): React.ReactNode {
  const entries = Object.entries(input ?? {})
  if (entries.length === 0) {
    return null
  }
  const summary = entries
    .slice(0, 3)
    .map(([k, v]) => {
      const str = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${str.length > 32 ? `${str.slice(0, 29)}…` : str}`
    })
    .join(', ')
  return <ThemedText dimColor>{summary}</ThemedText>
}

/**
 * Renders live MCP progress notifications with `<ProgressBar>` when total is known.
 */
export function renderMcpToolProgressMessage(
  progressMessages: ProgressMessage<McpProgress>[],
): React.ReactNode {
  const latest = progressMessages[progressMessages.length - 1]?.data
  if (!latest) {
    return null
  }
  const ratio =
    latest.progress !== undefined && latest.total && latest.total > 0
      ? Math.min(1, Math.max(0, latest.progress / latest.total))
      : null

  return (
    <Box flexDirection="row" gap={1}>
      {ratio !== null ? <ProgressBar ratio={ratio} width={16} showPercentage /> : null}
      <ThemedText dimColor>
        {latest.progressMessage ??
          `${latest.serverName}:${latest.toolName} (${latest.status})`}
      </ThemedText>
    </Box>
  )
}

/**
 * Renders the completed MCP tool result summary with an optional >10k-token badge.
 */
export function renderMcpToolResultMessage(
  output: McpToolOutput,
): React.ReactNode {
  const textChars = output.content.reduce(
    (acc, b) => acc + (b.type === 'text' ? b.text.length : 0),
    0,
  )
  const approxTokens = Math.ceil(textChars / 4)
  const firstText = output.content.find(b => b.type === 'text')
  const previewLine =
    firstText && firstText.type === 'text'
      ? (firstText.text.split('\n')[0] ?? '').slice(0, 100)
      : `${output.content.length} block(s)`

  return (
    <Box flexDirection="column">
      <ThemedText color={output.isError ? 'error' : undefined} dimColor={!output.isError}>
        {previewLine || 'Completed'}
      </ThemedText>
      {textChars > LARGE_TOKEN_WARNING_CHARS ? (
        <ThemedText color="warning">
          {FIGURES.warning} Large MCP output (~{approxTokens.toLocaleString()} tokens)
        </ThemedText>
      ) : null}
    </Box>
  )
}
