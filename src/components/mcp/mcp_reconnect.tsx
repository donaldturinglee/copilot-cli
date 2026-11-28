/**
 * One-shot `/mcp reconnect <serverName>` component.
 */

import React, { useEffect, useRef } from 'react'
import { useMcpReconnect } from '../../services/mcp/mcp_connection_manager.js'
import type { CommandResultDisplay } from '../../types/command.js'
import { Spinner } from '../spinner.js'

export interface McpReconnectProps {
  serverName: string
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

/**
 * Triggers an immediate reconnect for `serverName` and reports the outcome.
 */
export function MCPReconnect({
  serverName,
  onComplete,
}: McpReconnectProps): React.ReactNode {
  const reconnect = useMcpReconnect()
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void reconnect(serverName).then(res => {
      if (res.error) {
        onComplete(
          `Failed to reconnect MCP server "${serverName}": ${res.error}`,
        )
      } else {
        onComplete(
          `Reconnected MCP server "${serverName}" (${res.toolCount} tool(s) available).`,
        )
      }
    })
  }, [onComplete, reconnect, serverName])

  return (
    <Spinner
      mode="thinking"
      message={`Reconnecting MCP server "${serverName}"…`}
    />
  )
}
