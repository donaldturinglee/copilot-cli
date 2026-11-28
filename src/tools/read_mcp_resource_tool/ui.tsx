/**
 * Ink TUI renderer for `ReadMcpResourceTool`.
 */

import React from 'react'
import { ThemedText } from '../../components/design_system/themed_text.js'
import type { ReadMcpResourceOutput } from './read_mcp_resource_tool.js'

/**
 * Renders a concise summary of read MCP resource items.
 */
export function renderReadMcpResourceResult(
  output: ReadMcpResourceOutput,
): React.ReactNode {
  return (
    <ThemedText dimColor>
      Read {output.contents.length} item(s) from {output.server}:{output.uri}
    </ThemedText>
  )
}
