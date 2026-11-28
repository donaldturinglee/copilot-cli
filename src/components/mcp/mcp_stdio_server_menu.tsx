/**
 * Action menu for a stdio MCP server (view tools, reconnect, enable/disable).
 */

import React from 'react'
import { Box } from '../../ink/components/box.js'
import {
  useMcpReconnect,
  useMcpToggleEnabled,
} from '../../services/mcp/mcp_connection_manager.js'
import { getServerStatusIndicator } from '../../services/mcp/utils.js'
import type { CommandResultDisplay } from '../../types/command.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import { CapabilitiesSection } from './capabilities_section.js'
import type { ServerInfo } from './types.js'

export interface McpStdioServerMenuProps {
  server: Extract<ServerInfo, { transport: 'stdio' }>
  serverToolsCount: number
  onViewTools: () => void
  onCancel: () => void
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

/**
 * Detail and action dialog for a `stdio` MCP server.
 */
export function MCPStdioServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
}: McpStdioServerMenuProps): React.ReactNode {
  const reconnect = useMcpReconnect()
  const toggleEnabled = useMcpToggleEnabled()
  const status = getServerStatusIndicator(server.client.type)
  const isDisabled = server.client.type === 'disabled'
  const cmdDisplay = [server.config.command, ...(server.config.args ?? [])].join(
    ' ',
  )

  return (
    <Dialog
      title={server.name}
      subtitle={`stdio · ${server.scope}`}
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color={status.color}>
          Status: {status.symbol} {status.label}
        </ThemedText>
        <ThemedText dimColor>Command: {cmdDisplay}</ThemedText>
        <CapabilitiesSection
          capabilities={
            server.client.type === 'connected'
              ? server.client.capabilities
              : undefined
          }
          toolsCount={serverToolsCount}
        />
        <Select
          options={[
            ...(serverToolsCount > 0
              ? [
                  {
                    label: `View tools (${serverToolsCount})`,
                    value: 'tools',
                  },
                ]
              : []),
            { label: 'Reconnect server', value: 'reconnect' },
            {
              label: isDisabled ? 'Enable server' : 'Disable server',
              value: 'toggle',
            },
            { label: 'Back', value: 'back' },
          ]}
          onChange={val => {
            if (val === 'tools') {
              onViewTools()
            } else if (val === 'reconnect') {
              void reconnect(server.name).then(res => {
                onComplete(
                  res.error
                    ? `Failed to reconnect "${server.name}": ${res.error}`
                    : `Reconnected "${server.name}" (${res.toolCount} tool(s)).`,
                )
              })
            } else if (val === 'toggle') {
              void toggleEnabled(server.name).then(() => {
                onComplete(
                  `${isDisabled ? 'Enabled' : 'Disabled'} MCP server "${server.name}".`,
                )
              })
            } else {
              onCancel()
            }
          }}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
