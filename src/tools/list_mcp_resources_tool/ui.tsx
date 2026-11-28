/**
 * Ink TUI renderer for `ListMcpResourcesTool`.
 */

import React from 'react'
import { ThemedText } from '../../components/design_system/themed_text.js'
import type { ServerResource } from '../../services/mcp/types.js'

/**
 * Renders the resource count returned by `ListMcpResourcesTool`.
 */
export function renderListMcpResourcesResult(
  resources: ServerResource[],
): React.ReactNode {
  return (
    <ThemedText dimColor>
      Found {resources.length} MCP resource(s)
    </ThemedText>
  )
}
