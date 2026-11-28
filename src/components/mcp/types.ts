/**
 * Reconstructed UI state and view-model types for `src/components/mcp/*`.
 */

import type {
  AgentMcpServerInfo,
} from '../../services/mcp/utils.js'
import type {
  ConfigScope,
  McpClaudeAiProxyServerConfig,
  McpHttpServerConfig,
  McpServerConnection,
  McpSseServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'

export type { AgentMcpServerInfo }

export type McpPanelTab = 'Copilot CLI' | 'Claude Code' | 'claude.ai' | 'Agents'

export type ServerInfo =
  | {
      name: string
      client: McpServerConnection
      scope: ConfigScope
      transport: 'stdio'
      config: McpStdioServerConfig
      isAuthenticated?: boolean
    }
  | {
      name: string
      client: McpServerConnection
      scope: ConfigScope
      transport: 'sse'
      config: McpSseServerConfig
      isAuthenticated?: boolean
    }
  | {
      name: string
      client: McpServerConnection
      scope: ConfigScope
      transport: 'http'
      config: McpHttpServerConfig
      isAuthenticated?: boolean
    }
  | {
      name: string
      client: McpServerConnection
      scope: ConfigScope
      transport: 'claudeai-proxy'
      config: McpClaudeAiProxyServerConfig
      isAuthenticated?: boolean
    }

export type McpViewState =
  | { type: 'list'; defaultTab?: McpPanelTab }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }

export type MCPViewState = McpViewState
