/**
 * Core MCP configuration schemas, 8-transport server union, and runtime
 * connection state contracts.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  Resource,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utilities/lazy_schema.js'

export const ConfigScopeSchema = lazySchema(() =>
  z.enum([
    'local',
    'user',
    'project',
    'dynamic',
    'enterprise',
    'claudeai',
    'managed',
  ]),
)

export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>

export const TransportSchema = lazySchema(() =>
  z.enum([
    'stdio',
    'sse',
    'sse-ide',
    'http',
    'ws',
    'ws-ide',
    'sdk',
    'claudeai-proxy',
  ]),
)

export type McpTransportType = z.infer<ReturnType<typeof TransportSchema>>

export const McpOauthConfigSchema = lazySchema(() =>
  z.object({
    clientId: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    authServerMetadataUrl: z
      .string()
      .url()
      .refine(url => url.startsWith('https://'), {
        message: 'authServerMetadataUrl must use https://',
      })
      .optional(),
    xaa: z.boolean().optional(),
  }),
)

export type McpOauthConfig = z.infer<ReturnType<typeof McpOauthConfigSchema>>

export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
)

export type McpStdioServerConfig = z.infer<
  ReturnType<typeof McpStdioServerConfigSchema>
>

export const McpSseServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: McpOauthConfigSchema().optional(),
  }),
)

export type McpSseServerConfig = z.infer<
  ReturnType<typeof McpSseServerConfigSchema>
>

export const McpHttpServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: McpOauthConfigSchema().optional(),
  }),
)

export type McpHttpServerConfig = z.infer<
  ReturnType<typeof McpHttpServerConfigSchema>
>

export const McpWebSocketServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws'),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
  }),
)

export type McpWebSocketServerConfig = z.infer<
  ReturnType<typeof McpWebSocketServerConfigSchema>
>

export const McpSseIdeServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse-ide'),
    url: z.string().min(1),
    ideName: z.string().min(1),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

export type McpSseIdeServerConfig = z.infer<
  ReturnType<typeof McpSseIdeServerConfigSchema>
>

export const McpWebSocketIdeServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws-ide'),
    url: z.string().min(1),
    ideName: z.string().min(1),
    authToken: z.string().optional(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

export type McpWebSocketIdeServerConfig = z.infer<
  ReturnType<typeof McpWebSocketIdeServerConfigSchema>
>

export const McpSdkServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string().min(1),
  }),
)

export type McpSdkServerConfig = z.infer<
  ReturnType<typeof McpSdkServerConfigSchema>
>

export const McpClaudeAiProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string().min(1),
    id: z.string().min(1),
  }),
)

export type McpClaudeAiProxyServerConfig = z.infer<
  ReturnType<typeof McpClaudeAiProxyServerConfigSchema>
>

export const McpServerConfigSchema = lazySchema(() =>
  z.union([
    McpSseServerConfigSchema(),
    McpHttpServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpSseIdeServerConfigSchema(),
    McpWebSocketIdeServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAiProxyServerConfigSchema(),
    McpStdioServerConfigSchema(),
  ]),
)

export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  pluginSource?: string
}

export const McpJsonConfigSchema = lazySchema(() =>
  z.object({
    mcpServers: z.record(z.string(), McpServerConfigSchema()),
  }),
)

export type McpJsonConfig = z.infer<ReturnType<typeof McpJsonConfigSchema>>

export interface ConnectedMcpServer {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: { name: string; version: string }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
  [key: string]: unknown
}

export interface FailedMcpServer {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
  [key: string]: unknown
}

export interface NeedsAuthMcpServer {
  name: string
  type: 'needs-auth'
  config: ScopedMcpServerConfig
  [key: string]: unknown
}

export interface PendingMcpServer {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
  [key: string]: unknown
}

export interface DisabledMcpServer {
  name: string
  type: 'disabled'
  config: ScopedMcpServerConfig
  [key: string]: unknown
}

export type McpServerConnection =
  | ConnectedMcpServer
  | FailedMcpServer
  | NeedsAuthMcpServer
  | PendingMcpServer
  | DisabledMcpServer

export type ServerResource = Resource & {
  server: string
  [key: string]: unknown
}

export interface McpConfigWarning {
  serverName?: string
  message: string
}

export interface McpCliState {
  clients: Array<{
    name: string
    type: McpServerConnection['type']
    capabilities?: ServerCapabilities
    error?: string
  }>
  configs: Record<string, ScopedMcpServerConfig>
  tools: Array<{ name: string; serverName?: string; description?: string }>
  resources: Record<string, ServerResource[]>
}
