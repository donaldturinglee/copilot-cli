/**
 * Ink TUI rendering hooks for `LSPTool`.
 */

import React from 'react'
import { ThemedText } from '../../components/design_system/themed_text.js'
import { FallbackToolUseErrorMessage } from '../../components/fallback_tool_use_error_message.js'
import type { LspToolInput, LspToolOutput } from './schemas.js'
import { getSymbolAtPosition } from './symbol_context.js'

/**
 * Renders the target operation, file, 1-based coordinates, and resolved symbol token.
 */
export function renderLspToolUseMessage(
  input: Partial<LspToolInput>,
): React.ReactNode {
  if (!input.operation || !input.filePath) {
    return null
  }
  const symbol =
    input.line && input.character
      ? getSymbolAtPosition(input.filePath, input.line - 1, input.character - 1)
      : null
  return (
    <ThemedText dimColor>
      {input.operation} {input.filePath}
      {input.line ? `:${input.line}:${input.character ?? 1}` : ''}
      {symbol ? ` (${symbol})` : ''}
    </ThemedText>
  )
}

/**
 * Renders the result count summary for `LSPTool`.
 */
export function renderLspToolResultMessage(
  output: LspToolOutput,
): React.ReactNode {
  const countInfo =
    output.resultCount !== undefined
      ? `${output.resultCount} result(s)${output.fileCount ? ` across ${output.fileCount} file(s)` : ''}`
      : output.result.split('\n')[0] ?? 'Done'
  return <ThemedText dimColor>{countInfo}</ThemedText>
}

/**
 * Renders an LSP tool error message.
 */
export function renderLspToolErrorMessage(result: unknown): React.ReactNode {
  const text =
    typeof result === 'string'
      ? result
      : result instanceof Error
        ? result.message
        : String(result)
  return <FallbackToolUseErrorMessage message={text} />
}
