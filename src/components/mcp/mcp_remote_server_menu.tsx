/**
 * Action menu for remote (`http`, `sse`, `claudeai-proxy`) MCP servers,
 * supporting interactive OAuth login, token revocation, reconnect, and tool viewing.
 */

import React, { useState } from 'react'
import { Box } from '../../ink/components/box.js'
import {
  performMcpOauthFlow,
  revokeServerTokens,
  type OauthCapableMcpConfig,
} from '../../services/mcp/auth.js'
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

export interface McpRemoteServerMenuProps {
  server: Exclude<ServerInfo, { transport: 'stdio' }>
  serverToolsCount: number
  onViewTools: () => void
  onCancel: () => void
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

/**
 * Detail and action dialog for remote HTTP/SSE/Proxy MCP servers.
 */
export function MCPRemoteServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
}: McpRemoteServerMenuProps): React.ReactNode {
  const reconnect = useMcpReconnect()
  const toggleEnabled = useMcpToggleEnabled()
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const status = getServerStatusIndicator(server.client.type)
  const isDisabled = server.client.type === 'disabled'
  const supportsOauth =
    server.transport === 'http' || server.transport === 'sse'

  return (
    <Dialog
      title={server.name}
      subtitle={`${server.transport} · ${server.scope}`}
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color={status.color}>
          Status: {status.symbol} {status.label}
        </ThemedText>
        <ThemedText dimColor>URL: {server.config.url}</ThemedText>
        {authUrl ? (
          <ThemedText color="suggestion">Auth URL: {authUrl}</ThemedText>
        ) : null}
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
              ? [{ label: `View tools (${serverToolsCount})`, value: 'tools' }]
              : []),
            ...(supportsOauth
              ? [
                  {
                    label: server.isAuthenticated
                      ? 'Re-authenticate (OAuth)'
                      : 'Authenticate (OAuth)',
                    value: 'auth',
                  },
                ]
              : []),
            ...(supportsOauth && server.isAuthenticated
              ? [{ label: 'Clear authentication', value: 'logout' }]
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
            } else if (val === 'auth' && supportsOauth) {
              void performMcpOauthFlow(
                server.name,
                server.config as OauthCapableMcpConfig,
                url => setAuthUrl(url),
              )
                .then(() => reconnect(server.name))
                .then(res => {
                  onComplete(
                    `Authenticated "${server.name}" (${res.toolCount} tool(s)).`,
                  )
                })
                .catch(err => {
                  onComplete(
                    `Authentication failed for "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
                  )
                })
            } else if (val === 'logout' && supportsOauth) {
              void revokeServerTokens(
                server.name,
                server.config as OauthCapableMcpConfig,
              ).then(() => {
                onComplete(`Cleared OAuth tokens for "${server.name}".`)
              })
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
