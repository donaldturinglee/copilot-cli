/**
 * Root `/mcp` multi-view interactive settings dialog (`list` -> `server-menu`
 * -> `server-tools` -> `server-tool-detail` / `agent-server-menu`).
 */

import React, { useEffect, useMemo, useState } from 'react'
import { ClaudeAuthProvider } from '../../services/mcp/auth.js'
import type {
  ConfigScope,
  McpClaudeAiProxyServerConfig,
  McpHttpServerConfig,
  McpServerConnection,
  McpSseServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'
import {
  extractAgentMcpServers,
  filterToolsByServer,
} from '../../services/mcp/utils.js'
import { useAppState } from '../../state/app_state.js'
import type { CommandResultDisplay } from '../../types/command.js'
import { MCPAgentServerMenu } from './mcp_agent_server_menu.js'
import { MCPListPanel } from './mcp_list_panel.js'
import { MCPRemoteServerMenu } from './mcp_remote_server_menu.js'
import { MCPStdioServerMenu } from './mcp_stdio_server_menu.js'
import { MCPToolDetailView } from './mcp_tool_detail_view.js'
import { MCPToolListView } from './mcp_tool_list_view.js'
import type { AgentMcpServerInfo, McpViewState, ServerInfo } from './types.js'

export interface McpSettingsProps {
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

/**
 * Interactive MCP management panel mounted by `/mcp`.
 */
export function MCPSettings({
  onComplete,
}: McpSettingsProps): React.ReactNode {
  const mcp = useAppState(s => s.mcp)
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const [viewState, setViewState] = useState<McpViewState>({ type: 'list' })
  const [servers, setServers] = useState<ServerInfo[]>([])

  const agentMcpServers = useMemo(
    () => extractAgentMcpServers(agentDefinitions.allAgents),
    [agentDefinitions.allAgents],
  )

  const filteredClients = useMemo(
    () =>
      (mcp.clients as unknown as McpServerConnection[])
        .filter(c => c.name !== 'ide')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [mcp.clients],
  )

  useEffect(() => {
    let cancelled = false
    const prepare = async () => {
      const infos = await Promise.all(
        filteredClients.map(async (client): Promise<ServerInfo> => {
          const scope: ConfigScope = client.config?.scope ?? 'local'
          const cfgType = client.config?.type
          let isAuthenticated: boolean | undefined

          if (cfgType === 'sse' || cfgType === 'http') {
            const authProvider = new ClaudeAuthProvider(
              client.name,
              client.config as McpSseServerConfig | McpHttpServerConfig,
            )
            const tokens = await authProvider.tokens()
            const hasToolsAndConnected =
              client.type === 'connected' &&
              filterToolsByServer(mcp.tools, client.name).length > 0
            isAuthenticated = Boolean(tokens) || hasToolsAndConnected
          }

          if (cfgType === 'claudeai-proxy') {
            return {
              name: client.name,
              client,
              scope,
              transport: 'claudeai-proxy',
              isAuthenticated: client.type === 'connected',
              config: client.config as McpClaudeAiProxyServerConfig,
            }
          }
          if (cfgType === 'sse') {
            return {
              name: client.name,
              client,
              scope,
              transport: 'sse',
              isAuthenticated,
              config: client.config as McpSseServerConfig,
            }
          }
          if (cfgType === 'http') {
            return {
              name: client.name,
              client,
              scope,
              transport: 'http',
              isAuthenticated,
              config: client.config as McpHttpServerConfig,
            }
          }
          return {
            name: client.name,
            client,
            scope,
            transport: 'stdio',
            config: (client.config ?? { command: '' }) as McpStdioServerConfig,
          }
        }),
      )
      if (!cancelled) {
        setServers(infos)
      }
    }

    void prepare()
    return () => {
      cancelled = true
    }
  }, [filteredClients, mcp.tools])

  useEffect(() => {
    if (servers.length === 0 && filteredClients.length > 0) {
      return
    }
    if (servers.length === 0 && agentMcpServers.length === 0) {
      onComplete(
        'No MCP servers configured. Run `copilot mcp --help` to add an MCP server.',
      )
    }
  }, [agentMcpServers.length, filteredClients.length, onComplete, servers.length])

  switch (viewState.type) {
    case 'list':
      return (
        <MCPListPanel
          servers={servers}
          agentServers={agentMcpServers}
          onSelectServer={server => setViewState({ type: 'server-menu', server })}
          onSelectAgentServer={(agentServer: AgentMcpServerInfo) =>
            setViewState({ type: 'agent-server-menu', agentServer })
          }
          onComplete={onComplete}
          defaultTab={viewState.defaultTab}
        />
      )

    case 'server-menu': {
      const serverTools = filterToolsByServer(mcp.tools, viewState.server.name)
      const defaultTab =
        viewState.server.transport === 'claudeai-proxy'
          ? 'claude.ai'
          : 'Copilot CLI'
      if (viewState.server.transport === 'stdio') {
        return (
          <MCPStdioServerMenu
            server={viewState.server}
            serverToolsCount={serverTools.length}
            onViewTools={() =>
              setViewState({ type: 'server-tools', server: viewState.server })
            }
            onCancel={() => setViewState({ type: 'list', defaultTab })}
            onComplete={onComplete}
          />
        )
      }
      return (
        <MCPRemoteServerMenu
          server={viewState.server}
          serverToolsCount={serverTools.length}
          onViewTools={() =>
            setViewState({ type: 'server-tools', server: viewState.server })
          }
          onCancel={() => setViewState({ type: 'list', defaultTab })}
          onComplete={onComplete}
        />
      )
    }

    case 'server-tools':
      return (
        <MCPToolListView
          server={viewState.server}
          onSelectTool={(_tool, index) =>
            setViewState({
              type: 'server-tool-detail',
              server: viewState.server,
              toolIndex: index,
            })
          }
          onBack={() =>
            setViewState({ type: 'server-menu', server: viewState.server })
          }
        />
      )

    case 'server-tool-detail': {
      const serverTools = filterToolsByServer(mcp.tools, viewState.server.name)
      const picked = serverTools[viewState.toolIndex]
      if (!picked) {
        setViewState({ type: 'server-tools', server: viewState.server })
        return null
      }
      return (
        <MCPToolDetailView
          tool={picked}
          server={viewState.server}
          onBack={() =>
            setViewState({ type: 'server-tools', server: viewState.server })
          }
        />
      )
    }

    case 'agent-server-menu':
      return (
        <MCPAgentServerMenu
          agentServer={viewState.agentServer}
          onCancel={() =>
            setViewState({ type: 'list', defaultTab: 'Agents' })
          }
          onComplete={onComplete}
        />
      )

    default:
      return null
  }
}
