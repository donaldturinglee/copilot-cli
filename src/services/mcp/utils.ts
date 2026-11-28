/**
 * Shared UI & filtering helpers for MCP server status indicators, per-server
 * tool filtering, and agent-scoped MCP server extraction.
 */

import { FIGURES } from '../../constants/figures.js'
import type { AnyTool } from '../../tool.js'
import type { Tool } from '../../types/forward.js'
import { getMcpPrefix } from './mcp_string_utils.js'
import type {
  McpServerConfig,
  McpServerConnection,
  ServerResource,
} from './types.js'

export interface AgentMcpServerInfo {
  agentName: string
  serverName: string
  config: McpServerConfig
}

/**
 * Maps an MCP connection status to its glyph and semantic theme color.
 */
export function getServerStatusIndicator(
  type: McpServerConnection['type'],
): { symbol: string; color: 'success' | 'warning' | 'error' | 'dim'; label: string } {
  switch (type) {
    case 'connected':
      return { symbol: FIGURES.tick, color: 'success', label: 'connected' }
    case 'needs-auth':
      return { symbol: FIGURES.warning, color: 'warning', label: 'needs authentication' }
    case 'pending':
      return { symbol: FIGURES.ellipsis, color: 'dim', label: 'connecting' }
    case 'disabled':
      return { symbol: FIGURES.circleOpen, color: 'dim', label: 'disabled' }
    case 'failed':
    default:
      return { symbol: FIGURES.cross, color: 'error', label: 'failed' }
  }
}

/**
 * Filters an MCP tool array down to tools belonging to `serverName`.
 */
export function filterToolsByServer<ToolItem extends Tool | AnyTool>(
  tools: readonly ToolItem[],
  serverName: string,
): ToolItem[] {
  const prefix = getMcpPrefix(serverName)
  return tools.filter(tool => {
    const mcpInfo = (
      tool as { mcpInfo?: { serverName?: string } }
    ).mcpInfo
    if (mcpInfo?.serverName) {
      return mcpInfo.serverName === serverName
    }
    return tool.name.startsWith(prefix)
  })
}

/**
 * Summarizes tool and resource counts per MCP server.
 */
export function extractServerStats(
  clients: readonly McpServerConnection[],
  tools: readonly (Tool | AnyTool)[],
  resources: Record<string, ServerResource[]>,
): Record<
  string,
  { status: McpServerConnection['type']; toolCount: number; resourceCount: number }
> {
  const stats: Record<
    string,
    { status: McpServerConnection['type']; toolCount: number; resourceCount: number }
  > = {}
  for (const client of clients) {
    stats[client.name] = {
      status: client.type,
      toolCount: filterToolsByServer(tools, client.name).length,
      resourceCount: resources[client.name]?.length ?? 0,
    }
  }
  return stats
}

/**
 * Extracts inline `mcpServers` declared on loaded agent definitions.
 */
export function extractAgentMcpServers(
  agents: readonly unknown[],
): AgentMcpServerInfo[] {
  const list: AgentMcpServerInfo[] = []
  for (const raw of agents) {
    if (!raw || typeof raw !== 'object') continue
    const agent = raw as {
      agentType?: unknown
      name?: unknown
      mcpServers?: unknown
    }
    const agentName =
      typeof agent.agentType === 'string'
        ? agent.agentType
        : typeof agent.name === 'string'
          ? agent.name
          : null
    if (!agentName || !agent.mcpServers || typeof agent.mcpServers !== 'object') {
      continue
    }
    for (const [serverName, cfg] of Object.entries(
      agent.mcpServers as Record<string, unknown>,
    )) {
      if (cfg && typeof cfg === 'object') {
        list.push({
          agentName,
          serverName,
          config: cfg as McpServerConfig,
        })
      }
    }
  }
  return list
}
