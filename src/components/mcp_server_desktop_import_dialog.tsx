/**
 * Interactive import selector for `copilot mcp add-from-claude-desktop`.
 */

import React from 'react'
import { Box } from '../ink/components/box.js'
import { addMcpConfig } from '../services/mcp/config.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import { SelectMulti } from './custom_select/select_multi.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export interface McpServerDesktopImportDialogProps {
  servers: Record<string, McpServerConfig>
  scope: 'local' | 'user' | 'project'
  onComplete: (importedCount: number) => void
}

/**
 * Renders a multi-select dialog to import MCP servers from Claude Desktop.
 */
export function MCPServerDesktopImportDialog({
  servers,
  scope,
  onComplete,
}: McpServerDesktopImportDialogProps): React.ReactNode {
  const names = Object.keys(servers)
  if (names.length === 0) {
    return (
      <Dialog
        title="Import from Claude Desktop"
        onCancel={() => onComplete(0)}
      >
        <ThemedText dimColor>
          No MCP servers found in claude_desktop_config.json.
        </ThemedText>
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Import MCP Servers from Claude Desktop"
      subtitle={`Target scope: ${scope}`}
      onCancel={() => onComplete(0)}
    >
      <Box flexDirection="column" gap={1}>
        <SelectMulti
          options={names.map(name => ({ label: name, value: name }))}
          defaultValues={names}
          onSubmit={selected => {
            for (const name of selected) {
              const cfg = servers[name]
              if (cfg) {
                addMcpConfig(name, cfg, scope)
              }
            }
            onComplete(selected.length)
          }}
          onCancel={() => onComplete(0)}
        />
      </Box>
    </Dialog>
  )
}
