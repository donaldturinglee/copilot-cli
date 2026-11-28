/**
 * Main list panel for `/mcp` displaying configured Copilot CLI, `claude.ai`,
 * and Agent-scoped MCP servers with live connection badges.
 */

import React from 'react'
import { Box } from '../../ink/components/box.js'
import { getServerStatusIndicator } from '../../services/mcp/utils.js'
import type { CommandResultDisplay } from '../../types/command.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { AgentMcpServerInfo, McpPanelTab, ServerInfo } from './types.js'

export interface McpListPanelProps {
  servers: readonly ServerInfo[]
  agentServers: readonly AgentMcpServerInfo[]
  onSelectServer: (server: ServerInfo) => void
  onSelectAgentServer: (agentServer: AgentMcpServerInfo) => void
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  defaultTab?: McpPanelTab
}

/**
 * Renders the selectable list of MCP servers and agent MCP servers.
 */
export function MCPListPanel({
  servers,
  agentServers,
  onSelectServer,
  onSelectAgentServer,
  onComplete,
}: McpListPanelProps): React.ReactNode {
  const options = [
    ...servers.map((srv, idx) => {
      const status = getServerStatusIndicator(srv.client.type)
      return {
        label: `${status.symbol} ${srv.name} (${srv.transport} · ${srv.scope} · ${status.label})`,
        value: `srv:${idx}`,
      }
    }),
    ...agentServers.map((ag, idx) => ({
      label: `Agent ${ag.agentName} → ${ag.serverName}`,
      value: `agent:${idx}`,
    })),
  ]

  return (
    <Dialog
      title="Manage MCP Servers"
      subtitle={`${servers.length} server(s)`}
      onCancel={() => onComplete()}
    >
      <Box flexDirection="column" gap={1}>
        {options.length === 0 ? (
          <ThemedText dimColor>No MCP servers configured.</ThemedText>
        ) : (
          <Select
            options={options}
            onChange={val => {
              if (val.startsWith('srv:')) {
                const picked = servers[Number(val.slice(4))]
                if (picked) {
                  onSelectServer(picked)
                }
              } else if (val.startsWith('agent:')) {
                const picked = agentServers[Number(val.slice(6))]
                if (picked) {
                  onSelectAgentServer(picked)
                }
              }
            }}
            onCancel={() => onComplete()}
          />
        )}
      </Box>
    </Dialog>
  )
}
