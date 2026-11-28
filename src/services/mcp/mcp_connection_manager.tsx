/**
 * React Context provider exposing live MCP reconnect and enable/disable hooks
 * (`useMcpReconnect`, `useMcpToggleEnabled`) to REPL dialogs and slash commands.
 */

import React, { createContext, useContext } from 'react'
import type { ScopedMcpServerConfig } from './types.js'
import {
  useManageMcpConnections,
  type ReconnectResult,
} from './use_manage_mcp_connections.js'

interface McpConnectionContextValue {
  reconnectServer: (serverName: string) => Promise<ReconnectResult>
  toggleServerEnabled: (serverName: string) => Promise<void>
}

const defaultContextValue: McpConnectionContextValue = {
  reconnectServer: async serverName => ({
    client: {
      name: serverName,
      type: 'failed',
      config: { command: '', scope: 'local' },
      error: 'MCPConnectionManager not mounted',
    },
    toolCount: 0,
    error: 'MCPConnectionManager not mounted',
  }),
  toggleServerEnabled: async () => {},
}

const McpConnectionContext =
  createContext<McpConnectionContextValue>(defaultContextValue)

export interface McpConnectionManagerProps {
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  strictMcpConfig?: boolean
  children: React.ReactNode
}

/**
 * Mounts `useManageMcpConnections` and provides reconnect/toggle callbacks.
 */
export function MCPConnectionManager({
  dynamicMcpConfig,
  strictMcpConfig,
  children,
}: McpConnectionManagerProps): React.ReactNode {
  const value = useManageMcpConnections(dynamicMcpConfig, strictMcpConfig)
  return (
    <McpConnectionContext.Provider value={value}>
      {children}
    </McpConnectionContext.Provider>
  )
}

/**
 * Returns the live `(serverName) => Promise<ReconnectResult>` callback.
 */
export function useMcpReconnect(): (
  serverName: string,
) => Promise<ReconnectResult> {
  return useContext(McpConnectionContext).reconnectServer
}

/**
 * Returns the live `(serverName) => Promise<void>` enable/disable toggle callback.
 */
export function useMcpToggleEnabled(): (serverName: string) => Promise<void> {
  return useContext(McpConnectionContext).toggleServerEnabled
}
