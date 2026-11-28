/**
 * Pseudo-tool `mcp__<server>__authenticate` injected for `needs-auth` HTTP/SSE
 * MCP servers; triggers OAuth PKCE or silent XAA and hot-swaps discovered server
 * tools into `AppState.mcp` immediately upon completion.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import {
  performMcpOauthFlow,
  type OauthCapableMcpConfig,
} from '../../services/mcp/auth.js'
import { reconnectMcpServerImpl } from '../../services/mcp/client.js'
import { getMcpPrefix } from '../../services/mcp/mcp_string_utils.js'
import { normalizeNameForMcp } from '../../services/mcp/normalization.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { buildTool, type Tool, type ToolUseContext } from '../../tool.js'
import type { Tool as ForwardTool } from '../../types/forward.js'

export const MCP_AUTH_TOOL_PREFIX = 'mcp__'
export const MCP_AUTH_TOOL_SUFFIX = '__authenticate'

const EmptyAuthInputSchema = z.object({})
export type McpAuthToolInput = z.infer<typeof EmptyAuthInputSchema>

export interface McpAuthToolOutput {
  status: 'authenticated' | 'auth_url'
  url?: string
  message: string
}

/**
 * Returns true if `toolName` is a dynamic `mcp__<server>__authenticate` tool.
 */
export function isMcpAuthTool(toolName: string): boolean {
  return (
    toolName.startsWith(MCP_AUTH_TOOL_PREFIX) &&
    toolName.endsWith(MCP_AUTH_TOOL_SUFFIX)
  )
}

function hotSwapAuthenticatedServer(
  context: ToolUseContext,
  serverName: string,
  authToolName: string,
  reconnected: Awaited<ReturnType<typeof reconnectMcpServerImpl>>,
): void {
  const prefix = getMcpPrefix(serverName)
  context.setAppState?.(prev => {
    const nextClients = prev.mcp.clients.map(c =>
      c.name === serverName ? reconnected.client : c,
    )
    if (!nextClients.some(c => c.name === serverName)) {
      nextClients.push(reconnected.client)
    }
    const keptTools = prev.mcp.tools.filter(
      t => t.name !== authToolName && !t.name.startsWith(prefix),
    )
    const nextCommands = [
      ...prev.mcp.commands.filter(
        c => !c.name.startsWith(prefix),
      ),
      ...reconnected.commands,
    ]
    return {
      ...prev,
      authVersion: prev.authVersion + 1,
      mcp: {
        ...prev.mcp,
        clients: nextClients,
        tools: [
          ...keptTools,
          ...(reconnected.tools as unknown as ForwardTool[]),
        ],
        commands: nextCommands,
        resources: {
          ...prev.mcp.resources,
          ...(reconnected.resources.length > 0
            ? { [serverName]: reconnected.resources }
            : {}),
        },
      },
    }
  })
}

/**
 * Creates a server-bound `mcp__<server>__authenticate` tool that performs OAuth
 * or silent XAA and hot-swaps live MCP tools into `AppState`.
 */
export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
): Tool<McpAuthToolInput, McpAuthToolOutput> {
  const toolName = `mcp__${normalizeNameForMcp(serverName)}${MCP_AUTH_TOOL_SUFFIX}`
  const oauthConfig = config as OauthCapableMcpConfig

  return buildTool<McpAuthToolInput, McpAuthToolOutput>({
    name: toolName,
    isMcp: true,
    alwaysLoad: true,
    mcpInfo: { serverName, toolName: 'authenticate' },
    maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    inputSchema: EmptyAuthInputSchema,

    isReadOnly: () => true,
    isConcurrencySafe: () => false,

    userFacingName() {
      return `${serverName} - Authenticate (MCP)`
    },

    async description() {
      return `Initiates OAuth authentication for MCP server "${serverName}", which currently requires authentication before its tools can be used.`
    },

    async prompt() {
      return `Call ${toolName} to authenticate MCP server "${serverName}" and unlock its tools.`
    },

    async call(_args, context: ToolUseContext) {
      let resolveUrl!: (url: string) => void
      const authUrlPromise = new Promise<string>(resolve => {
        resolveUrl = resolve
      })

      const flowPromise = performMcpOauthFlow(
        serverName,
        oauthConfig,
        url => resolveUrl(url),
        context.abortController.signal,
        { skipBrowserOpen: true },
      )

      const winner = await Promise.race([
        flowPromise.then(() => ({ kind: 'completed' as const })),
        authUrlPromise.then(url => ({ kind: 'url' as const, url })),
      ])

      if (winner.kind === 'completed') {
        const reconnected = await reconnectMcpServerImpl(serverName, config)
        hotSwapAuthenticatedServer(context, serverName, toolName, reconnected)
        return {
          data: {
            status: 'authenticated',
            message: `Authenticated with MCP server "${serverName}" (${reconnected.tools.length} tool(s) now available).`,
          },
        }
      }

      // Browser consent required: hot-swap in background as soon as user finishes callback
      void flowPromise
        .then(() => reconnectMcpServerImpl(serverName, config))
        .then(reconnected => {
          hotSwapAuthenticatedServer(context, serverName, toolName, reconnected)
        })
        .catch(() => {})

      return {
        data: {
          status: 'auth_url',
          url: winner.url,
          message: `Open the following URL in your browser to authenticate MCP server "${serverName}":\n${winner.url}`,
        },
      }
    },

    mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output.message,
      }
    },
  })
}
