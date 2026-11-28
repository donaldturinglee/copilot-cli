/**
 * Inspector view for an MCP server declared inside an Agent definition.
 */

import React from 'react'
import { Box } from '../../ink/components/box.js'
import type { CommandResultDisplay } from '../../types/command.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { AgentMcpServerInfo } from './types.js'

export interface McpAgentServerMenuProps {
  agentServer: AgentMcpServerInfo
  onCancel: () => void
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

/**
 * Displays metadata for an agent-scoped MCP server.
 */
export function MCPAgentServerMenu({
  agentServer,
  onCancel,
  onComplete,
}: McpAgentServerMenuProps): React.ReactNode {
  const transport = agentServer.config.type ?? 'stdio'
  const detail =
    'command' in agentServer.config
      ? `${agentServer.config.command} ${(agentServer.config.args ?? []).join(' ')}`.trim()
      : 'url' in agentServer.config
        ? agentServer.config.url
        : agentServer.serverName

  return (
    <Dialog
      title={`${agentServer.agentName} → ${agentServer.serverName}`}
      subtitle={`Agent MCP server (${transport})`}
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText dimColor>Endpoint: {detail}</ThemedText>
        <Select
          options={[
            { label: 'Back to MCP list', value: 'back' },
            { label: 'Close', value: 'close' },
          ]}
          onChange={val => (val === 'back' ? onCancel() : onComplete())}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}
