/**
 * Interactive tool list view for a single connected MCP server.
 */

import React from 'react'
import { Box } from '../../ink/components/box.js'
import { getMcpDisplayName } from '../../services/mcp/mcp_string_utils.js'
import { filterToolsByServer } from '../../services/mcp/utils.js'
import { useAppState } from '../../state/app_state.js'
import type { Tool } from '../../types/forward.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { ServerInfo } from './types.js'

export interface McpToolListViewProps {
  server: ServerInfo
  onSelectTool: (tool: Tool, index: number) => void
  onBack: () => void
}

/**
 * Lists all tools discovered on `server` for inspection.
 */
export function MCPToolListView({
  server,
  onSelectTool,
  onBack,
}: McpToolListViewProps): React.ReactNode {
  const allMcpTools = useAppState(s => s.mcp.tools)
  const serverTools = filterToolsByServer(allMcpTools, server.name)

  if (serverTools.length === 0) {
    return (
      <Dialog
        title={`Tools for ${server.name}`}
        subtitle="0 tools"
        onCancel={onBack}
      >
        <ThemedText dimColor>
          No tools exposed by this MCP server. Press Esc to go back.
        </ThemedText>
      </Dialog>
    )
  }

  const options = serverTools.map((tool, index) => {
    const shortName = getMcpDisplayName(tool.name, server.name)
    const maybeReadOnly = (
      tool as unknown as { isReadOnly?: (arg: Record<string, unknown>) => boolean }
    ).isReadOnly
    const isReadOnly =
      typeof maybeReadOnly === 'function' ? Boolean(maybeReadOnly({})) : false
    return {
      label: isReadOnly ? `${shortName} (read-only)` : shortName,
      value: String(index),
    }
  })

  return (
    <Dialog
      title={`Tools for ${server.name}`}
      subtitle={`${serverTools.length} tool(s)`}
      onCancel={onBack}
    >
      <Box flexDirection="column">
        <Select
          options={options}
          onChange={val => {
            const idx = Number(val)
            const picked = serverTools[idx]
            if (picked) {
              onSelectTool(picked, idx)
            }
          }}
          onCancel={onBack}
        />
      </Box>
    </Dialog>
  )
}
