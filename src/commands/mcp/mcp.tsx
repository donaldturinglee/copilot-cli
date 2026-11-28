/**
 * `/mcp` slash command (`mcp`, `mcp reconnect <name>`, `mcp enable [name]`,
 * `mcp disable [name]`).
 */

import React, { useEffect, useRef } from 'react'
import { MCPSettings } from '../../components/mcp/index.js'
import { MCPReconnect } from '../../components/mcp/mcp_reconnect.js'
import { useMcpToggleEnabled } from '../../services/mcp/mcp_connection_manager.js'
import { useAppState } from '../../state/app_state.js'
import type { LocalJsxCommandOnDone } from '../../types/command.js'

function McpToggle({
  action,
  target,
  onComplete,
}: {
  action: 'enable' | 'disable'
  target: string
  onComplete: (result: string) => void
}): null {
  const mcpClients = useAppState(s => s.mcp.clients)
  const toggleMcpServer = useMcpToggleEnabled()
  const didRun = useRef(false)

  useEffect(() => {
    if (didRun.current) return
    didRun.current = true

    const isEnabling = action === 'enable'
    const clients = mcpClients.filter(c => c.name !== 'ide')
    const toToggle =
      target === 'all'
        ? clients.filter(c =>
            isEnabling ? c.type === 'disabled' : c.type !== 'disabled',
          )
        : clients.filter(c => c.name === target)

    if (toToggle.length === 0) {
      onComplete(
        target === 'all'
          ? `All MCP servers are already ${isEnabling ? 'enabled' : 'disabled'}`
          : `MCP server "${target}" not found`,
      )
      return
    }

    for (const s of toToggle) {
      void toggleMcpServer(s.name)
    }

    onComplete(
      target === 'all'
        ? `${isEnabling ? 'Enabled' : 'Disabled'} ${toToggle.length} MCP server(s)`
        : `MCP server "${target}" ${isEnabling ? 'enabled' : 'disabled'}`,
    )
  }, [action, mcpClients, onComplete, target, toggleMcpServer])

  return null
}

/**
 * Executes the `/mcp` interactive command.
 */
export async function call(
  onDone: LocalJsxCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  if (args) {
    const parts = args.trim().split(/\s+/)
    if (parts[0] === 'no-redirect') {
      return <MCPSettings onComplete={onDone} />
    }
    if (parts[0] === 'reconnect' && parts[1]) {
      return (
        <MCPReconnect
          serverName={parts.slice(1).join(' ')}
          onComplete={onDone}
        />
      )
    }
    if (parts[0] === 'enable' || parts[0] === 'disable') {
      return (
        <McpToggle
          action={parts[0]}
          target={parts.length > 1 ? parts.slice(1).join(' ') : 'all'}
          onComplete={onDone}
        />
      )
    }
  }
  return <MCPSettings onComplete={onDone} />
}
