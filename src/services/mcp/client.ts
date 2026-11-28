/**
 * Multi-transport MCP client engine supporting all 8 server transports
 * (`stdio`, `sse`, `http`, `ws`, `sse-ide`, `ws-ide`, `sdk`, `claudeai-proxy`)
 * plus `InProcessTransport`, OAuth 401/403 step-up & 15-minute `needs-auth`
 * caching, `-32001` session-expiry recovery, `-32042` URL elicitation retry,
 * and concurrent local/remote connection batching.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import zipObject from 'lodash-es/zipObject.js'
import pMap from 'p-map'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { z } from 'zod/v4'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createFetchWithInit,
  type FetchLike,
  type Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListRootsRequestSchema,
  ListToolsResultSchema,
  McpError,
  type CallToolResult,
  type PromptMessage,
  type Tool as SdkMcpTool,
} from '@modelcontextprotocol/sdk/types.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import {
  asAnyTool,
  type AnyTool,
  type ToolInputJsonSchema,
} from '../../tool.js'
import { ListMcpResourcesTool } from '../../tools/list_mcp_resources_tool/list_mcp_resources_tool.js'
import { createMcpAuthTool } from '../../tools/mcp_auth_tool/mcp_auth_tool.js'
import { createMcpToolInstance } from '../../tools/mcp_tool/mcp_tool.js'
import { ReadMcpResourceTool } from '../../tools/read_mcp_resource_tool/read_mcp_resource_tool.js'
import type { Command } from '../../types/command.js'
import { logForDebugging } from '../../utilities/debug.js'
import {
  getClaudeConfigHomeDir,
  isEnvFalsy,
  isEnvTruthy,
} from '../../utilities/env_utils.js'
import { getMcpUserAgent, withOauth401Retry } from '../../utilities/http.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBuffer,
} from '../../utilities/image_resizer.js'
import type { SupportedImageMediaType } from '../../utilities/image_validation.js'
import {
  WebSocketTransport,
  type WebSocketLike,
} from '../../utilities/mcp_websocket_transport.js'
import { getWebSocketTlsOptions } from '../../utilities/mtls.js'
import {
  getProxyFetchOptions,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utilities/proxy.js'
import { saveGlobalConfig } from '../../utilities/config.js'
import { getSecureStorage } from '../../utilities/secure_storage/index.js'
import { subprocessEnv } from '../../utilities/subprocess_env.js'
import { persistBinaryContent } from '../../utilities/tool_result_storage.js'
import {
  ClaudeAuthProvider,
  getServerKey,
  hasMcpDiscoveryButNoToken,
  wrapFetchWithStepUpDetection,
} from './auth.js'
import { isMcpServerDisabled } from './config.js'
import { getMcpServerHeaders } from './headers_helper.js'
import { buildMcpToolName } from './mcp_string_utils.js'
import { normalizeNameForMcp } from './normalization.js'
import {
  SdkControlClientTransport,
  type SendSdkMcpMessageFn,
} from './sdk_control_transport.js'
import type {
  ConnectedMcpServer,
  McpServerConfig,
  McpServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'

const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000
const NON_GET_REQUEST_TIMEOUT_MS = 60_000
const MAX_ERRORS_BEFORE_RECONNECT = 3
const URL_ELICITATION_REQUIRED_CODE = -32042
const SESSION_NOT_FOUND_CODE = -32001
const ALLOWED_IDE_TOOLS = new Set(['executeCode', 'getDiagnostics'])

/**
 * Thrown when an HTTP/SSE MCP server rejects a request with HTTP 404 / `-32001`
 * indicating the server-side session expired and must be re-initialized.
 */
export class McpSessionExpiredError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP session expired for server "${serverName}"`)
    this.name = 'McpSessionExpiredError'
  }
}

/**
 * Detects whether `error` indicates an expired MCP HTTP/SSE session (`404` + `-32001`).
 */
export function isMcpSessionExpiredError(error: unknown): boolean {
  if (error instanceof McpSessionExpiredError) {
    return true
  }
  if (error instanceof McpError && error.code === SESSION_NOT_FOUND_CODE) {
    return true
  }
  const msg = error instanceof Error ? error.message : String(error)
  return (
    (msg.includes('404') && msg.toLowerCase().includes('session')) ||
    msg.includes('-32001')
  )
}

function getNeedsAuthCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'mcp-needs-auth-cache.json')
}

function readNeedsAuthCache(): Record<string, number> {
  const path = getNeedsAuthCachePath()
  if (!existsSync(path)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function isServerCachedAsNeedsAuth(
  name: string,
  config: McpServerConfig,
): boolean {
  const cache = readNeedsAuthCache()
  const key = getServerKey(name, config)
  const timestamp = cache[key]
  if (!timestamp) {
    return false
  }
  return Date.now() - timestamp < MCP_AUTH_CACHE_TTL_MS
}

function markServerAsNeedsAuth(name: string, config: McpServerConfig): void {
  try {
    const dir = getClaudeConfigHomeDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const cache = readNeedsAuthCache()
    cache[getServerKey(name, config)] = Date.now()
    writeFileSync(getNeedsAuthCachePath(), JSON.stringify(cache), {
      mode: 0o600,
    })
  } catch {
    // Non-fatal cache write failure
  }
}

/**
 * Clears the 15-minute `mcp-needs-auth-cache.json` entry for `name` (or all
 * entries when omitted).
 */
export function clearMcpAuthCache(
  name?: string,
  config?: McpServerConfig,
): void {
  try {
    const path = getNeedsAuthCachePath()
    if (!existsSync(path)) {
      return
    }
    if (!name || !config) {
      writeFileSync(path, '{}', { mode: 0o600 })
      return
    }
    const cache = readNeedsAuthCache()
    delete cache[getServerKey(name, config)]
    writeFileSync(path, JSON.stringify(cache), { mode: 0o600 })
  } catch {
    // Non-fatal
  }
}

function getConnectionTimeoutMs(): number {
  const raw = Number(process.env.MCP_TIMEOUT)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw)
  }
  return DEFAULT_CONNECTION_TIMEOUT_MS
}

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  const proxyOpts = getProxyFetchOptions()
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', getMcpUserAgent())
    }
    if (method === 'POST' && !headers.has('Accept')) {
      headers.set('Accept', 'application/json, text/event-stream')
    }

    if (method === 'GET') {
      return baseFetch(url, {
        ...proxyOpts,
        ...init,
        headers,
      } as RequestInit)
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('MCP HTTP request timed out')),
      NON_GET_REQUEST_TIMEOUT_MS,
    )
    timer.unref?.()
    init?.signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    })
    try {
      return await baseFetch(url, {
        ...proxyOpts,
        ...init,
        headers,
        signal: controller.signal,
      } as RequestInit)
    } finally {
      clearTimeout(timer)
    }
  }
}

async function openWebSocketConnection(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocketLike> {
  const wsMod = await import('ws')
  const WsCtor = wsMod.default
  const socket = new WsCtor(url, ['mcp'], {
    headers: {
      'User-Agent': getMcpUserAgent(),
      ...headers,
    },
    agent: getWebSocketProxyAgent(url),
    ...(getWebSocketTlsOptions() ?? {}),
    ...(typeof Bun !== 'undefined' && getWebSocketProxyUrl(url)
      ? ({ proxy: getWebSocketProxyUrl(url) } as Record<string, unknown>)
      : {}),
  })
  return socket as unknown as WebSocketLike
}

function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) {
    return true
  }
  const msg = error instanceof Error ? error.message : String(error)
  return (
    msg.includes('401') ||
    msg.toLowerCase().includes('unauthorized') ||
    msg.toLowerCase().includes('missing authorization')
  )
}

function getServerCacheKey(name: string, serverRef: ScopedMcpServerConfig): string {
  return `${name}-${JSON.stringify(serverRef)}`
}

const activeConnections = new Map<string, ConnectedMcpServer>()
const inProcessTransports = new Map<string, () => Transport>()

/**
 * Registers an in-process MCP client `Transport` factory by server name (useful
 * for programmatic in-memory servers and integration tests).
 */
export function registerInProcessMcpTransport(
  serverName: string,
  factory: () => Transport,
): void {
  inProcessTransports.set(serverName, factory)
}

/**
 * Unregisters an in-process MCP client `Transport` factory.
 */
export function unregisterInProcessMcpTransport(serverName: string): void {
  inProcessTransports.delete(serverName)
}

async function createTransportForServer(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<{
  transport: Transport
  stderrChunks: string[]
  customCleanup?: () => Promise<void>
}> {
  const stderrChunks: string[] = []

  const inProcessFactory = inProcessTransports.get(name)
  if (inProcessFactory) {
    return { transport: inProcessFactory(), stderrChunks }
  }

  if (!serverRef.type || serverRef.type === 'stdio') {
    const stdioTransport = new StdioClientTransport({
      command: serverRef.command,
      args: serverRef.args ?? [],
      env: {
        ...subprocessEnv(),
        ...(serverRef.env ?? {}),
      } as Record<string, string>,
      stderr: 'pipe',
    })
    const stderrStream = stdioTransport.stderr
    if (stderrStream && 'on' in stderrStream) {
      let bufferedBytes = 0
      stderrStream.on('data', (chunk: Buffer | string) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (bufferedBytes < 64 * 1024 * 1024) {
          bufferedBytes += str.length
          stderrChunks.push(str)
        }
      })
    }
    return {
      transport: stdioTransport,
      stderrChunks,
      customCleanup: async () => {
        await stdioTransport.close().catch(() => {})
      },
    }
  }

  if (serverRef.type === 'sse') {
    const authProvider = new ClaudeAuthProvider(name, serverRef)
    const headers = (await getMcpServerHeaders(name, serverRef)) ?? {}
    const baseFetch = wrapFetchWithStepUpDetection(
      createFetchWithInit(),
      authProvider,
    )
    const sseStreamFetch: FetchLike = async (url, init) => {
      const mergedHeaders = new Headers(init?.headers)
      for (const [k, v] of Object.entries(headers)) {
        mergedHeaders.set(k, v)
      }
      const tokens = await authProvider.tokens()
      if (tokens?.access_token && !mergedHeaders.has('Authorization')) {
        mergedHeaders.set('Authorization', `Bearer ${tokens.access_token}`)
      }
      mergedHeaders.set('Accept', 'text/event-stream')
      mergedHeaders.set('User-Agent', getMcpUserAgent())
      return fetch(url, {
        ...getProxyFetchOptions(),
        ...init,
        headers: mergedHeaders,
      } as RequestInit)
    }
    const transport = new SSEClientTransport(new URL(serverRef.url), {
      authProvider,
      requestInit: { headers },
      eventSourceInit: { fetch: sseStreamFetch },
      fetch: wrapFetchWithTimeout(baseFetch),
    })
    return { transport, stderrChunks }
  }

  if (serverRef.type === 'http') {
    const authProvider = new ClaudeAuthProvider(name, serverRef)
    const headers = (await getMcpServerHeaders(name, serverRef)) ?? {}
    const baseFetch = wrapFetchWithStepUpDetection(
      createFetchWithInit(),
      authProvider,
    )
    const transport = new StreamableHTTPClientTransport(
      new URL(serverRef.url),
      {
        authProvider,
        requestInit: { headers },
        fetch: wrapFetchWithTimeout(baseFetch),
      },
    )
    return { transport, stderrChunks }
  }

  if (serverRef.type === 'ws') {
    const headers = (await getMcpServerHeaders(name, serverRef)) ?? {}
    const socket = await openWebSocketConnection(serverRef.url, headers)
    return { transport: new WebSocketTransport(socket), stderrChunks }
  }

  if (serverRef.type === 'sse-ide') {
    const transport = new SSEClientTransport(new URL(serverRef.url), {
      fetch: wrapFetchWithTimeout(createFetchWithInit()),
    })
    return { transport, stderrChunks }
  }

  if (serverRef.type === 'ws-ide') {
    const headers: Record<string, string> = {}
    if (serverRef.authToken) {
      headers['X-Claude-Code-Ide-Authorization'] = serverRef.authToken
    }
    const socket = await openWebSocketConnection(serverRef.url, headers)
    return { transport: new WebSocketTransport(socket), stderrChunks }
  }

  if (serverRef.type === 'claudeai-proxy') {
    const oauthCfg = getOauthConfig()
    const proxyBase = (serverRef.url || oauthCfg.MCP_PROXY_URL).replace(
      /\/+$/,
      '',
    )
    const proxyPath = oauthCfg.MCP_PROXY_PATH.replace(
      '{server_id}',
      encodeURIComponent(serverRef.id),
    )
    const endpoint = new URL(`${proxyBase}${proxyPath}`)
    const proxyFetch: FetchLike = async (url, init) => {
      return withOauth401Retry(async () => {
        const oauthTokens = getSecureStorage().read()?.claudeAiOauth
        if (!oauthTokens?.accessToken) {
          throw new UnauthorizedError('Missing claude.ai OAuth token')
        }
        const mergedHeaders = new Headers(init?.headers)
        mergedHeaders.set('Authorization', `Bearer ${oauthTokens.accessToken}`)
        mergedHeaders.set('X-Mcp-Client-Session-Id', getSessionId())
        mergedHeaders.set('User-Agent', getMcpUserAgent())
        return wrapFetchWithTimeout(createFetchWithInit())(url, {
          ...init,
          headers: mergedHeaders,
        })
      })
    }
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: proxyFetch,
    })
    return { transport, stderrChunks }
  }

  throw new Error(
    `SDK MCP server "${name}" must be initialized via setupSdkMcpClients()`,
  )
}

async function connectWithTransport(
  name: string,
  serverRef: ScopedMcpServerConfig,
  transport: Transport,
  stderrChunks: string[],
  customCleanup?: () => Promise<void>,
): Promise<ConnectedMcpServer> {
  const client = new Client(
    { name: 'claude-code', version: getMacroVersion() },
    {
      capabilities: {
        roots: {},
        // Must remain an empty object `{}` for Spring AI / strict MCP servers
        elicitation: {},
      },
    },
  )

  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(getOriginalCwd() || process.cwd()).href }],
  }))
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: 'cancel' as const,
  }))

  let consecutiveErrors = 0
  transport.onerror = err => {
    consecutiveErrors++
    logForDebugging(
      `MCP transport error on "${name}" (#${consecutiveErrors}): ${err.message}`,
    )
    if (consecutiveErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
      void client.close().catch(() => {})
    }
  }

  const timeoutMs = getConnectionTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void transport.close().catch(() => {})
          reject(
            new Error(
              `Timed out connecting to MCP server "${name}" after ${timeoutMs}ms`,
            ),
          )
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    const stderrTail = stderrChunks.join('').trim().slice(-500)
    if (stderrTail && error instanceof Error) {
      error.message = `${error.message}\nStderr: ${stderrTail}`
    }
    throw error
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }

  if (serverRef.type === 'sse-ide' || serverRef.type === 'ws-ide') {
    await client
      .notification({ method: 'notifications/claude/ideConnected', params: {} })
      .catch(() => {})
  }

  if (serverRef.type === 'claudeai-proxy') {
    saveGlobalConfig(prev => {
      const existing = new Set(prev.claudeAiMcpEverConnected ?? [])
      if (existing.has(name)) {
        return prev
      }
      existing.add(name)
      return { ...prev, claudeAiMcpEverConnected: Array.from(existing) }
    })
  }

  const capabilities = client.getServerCapabilities() ?? {}
  const serverVersion = client.getServerVersion()
  const instructions = client.getInstructions()

  const cleanup = async () => {
    activeConnections.delete(name)
    if (customCleanup) {
      await customCleanup()
    }
    await client.close().catch(() => {})
  }

  const connected: ConnectedMcpServer = {
    client,
    name,
    type: 'connected',
    capabilities,
    ...(serverVersion
      ? {
          serverInfo: {
            name: serverVersion.name,
            version: serverVersion.version,
          },
        }
      : {}),
    ...(instructions ? { instructions } : {}),
    config: serverRef,
    cleanup,
  }
  activeConnections.set(name, connected)
  return connected
}

async function connectToServerImpl(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<McpServerConnection> {
  if (isMcpServerDisabled(name)) {
    return { name, type: 'disabled', config: serverRef }
  }

  if (
    (serverRef.type === 'sse' || serverRef.type === 'http') &&
    !inProcessTransports.has(name) &&
    (isServerCachedAsNeedsAuth(name, serverRef) ||
      hasMcpDiscoveryButNoToken(name, serverRef))
  ) {
    return { name, type: 'needs-auth', config: serverRef }
  }

  try {
    const { transport, stderrChunks, customCleanup } =
      await createTransportForServer(name, serverRef)
    return await connectWithTransport(
      name,
      serverRef,
      transport,
      stderrChunks,
      customCleanup,
    )
  } catch (error) {
    if (isUnauthorizedError(error)) {
      if (serverRef.type === 'sse' || serverRef.type === 'http') {
        markServerAsNeedsAuth(name, serverRef)
      }
      return { name, type: 'needs-auth', config: serverRef }
    }
    return {
      name,
      type: 'failed',
      config: serverRef,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Memoized MCP server connection initializer.
 */
export const connectToServer = memoize(connectToServerImpl, getServerCacheKey)

/**
 * Connects in-process SDK-bridged MCP servers (`type: 'sdk'`) over `sendMcpMessage`.
 */
export async function setupSdkMcpClients(
  sdkServers: Record<string, ScopedMcpServerConfig>,
  sendMcpMessage: SendSdkMcpMessageFn,
): Promise<{
  clients: McpServerConnection[]
  transports: Map<string, SdkControlClientTransport>
}> {
  const clients: McpServerConnection[] = []
  const transports = new Map<string, SdkControlClientTransport>()

  for (const [name, config] of Object.entries(sdkServers)) {
    const transport = new SdkControlClientTransport(name, sendMcpMessage)
    transports.set(name, transport)
    try {
      const connected = await connectWithTransport(name, config, transport, [])
      clients.push(connected)
    } catch (error) {
      clients.push({
        name,
        type: 'failed',
        config,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { clients, transports }
}

/**
 * Transforms MCP `PromptMessage['content']` or tool result blocks into Anthropic
 * `ContentBlockParam[]`.
 */
export async function transformMcpContentBlocks(
  blocks: readonly unknown[],
): Promise<ContentBlockParam[]> {
  const out: ContentBlockParam[] = []
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>

    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
      continue
    }

    if (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      const buf = Buffer.from(block.data, 'base64')
      const resized = await maybeResizeAndDownsampleImageBuffer(
        buf,
        block.mimeType as SupportedImageMediaType,
      )
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: resized.mediaType,
          data: resized.base64,
        },
      })
      const metaCaption = createImageMetadataText(resized.dimensions)
      if (metaCaption) {
        out.push({ type: 'text', text: metaCaption })
      }
      continue
    }

    if (
      block.type === 'audio' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      const buf = Buffer.from(block.data, 'base64')
      const saved = await persistBinaryContent(buf, block.mimeType, 'mcp_audio')
      out.push({
        type: 'text',
        text:
          'filepath' in saved
            ? `[Audio (${block.mimeType}, ${saved.size} bytes) saved to: ${saved.filepath}]`
            : `[Audio (${block.mimeType}) persistence failed: ${saved.error}]`,
      })
      continue
    }

    if (block.type === 'resource_link' && typeof block.uri === 'string') {
      const name = typeof block.name === 'string' ? block.name : block.uri
      const desc =
        typeof block.description === 'string' ? ` — ${block.description}` : ''
      out.push({
        type: 'text',
        text: `[Resource link: ${name} (${block.uri})${desc}]`,
      })
      continue
    }

    if (
      block.type === 'resource' &&
      block.resource &&
      typeof block.resource === 'object'
    ) {
      const res = block.resource as {
        uri?: string
        mimeType?: string
        text?: string
        blob?: string
      }
      if (typeof res.text === 'string') {
        out.push({
          type: 'text',
          text: res.uri ? `[Resource ${res.uri}]\n${res.text}` : res.text,
        })
      } else if (typeof res.blob === 'string') {
        const mime = res.mimeType ?? 'application/octet-stream'
        const buf = Buffer.from(res.blob, 'base64')
        if (mime.startsWith('image/')) {
          const resized = await maybeResizeAndDownsampleImageBuffer(
            buf,
            mime as SupportedImageMediaType,
          )
          out.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: resized.mediaType,
              data: resized.base64,
            },
          })
        } else {
          const saved = await persistBinaryContent(buf, mime, 'mcp_resource')
          out.push({
            type: 'text',
            text:
              'filepath' in saved
                ? `[Binary resource ${res.uri ?? ''} (${mime}, ${saved.size} bytes) saved to: ${saved.filepath}]`
                : `[Binary resource ${res.uri ?? ''} failed to save: ${saved.error}]`,
          })
        }
      }
    }
  }
  return out
}

async function fetchToolsForClientImpl(
  server: ConnectedMcpServer,
): Promise<AnyTool[]> {
  if (!server.capabilities?.tools && server.capabilities !== undefined) {
    // Attempt tools/list only if tools capability is advertised or capabilities are unspecified
    if (Object.keys(server.capabilities).length > 0) {
      return []
    }
  }

  const response = await server.client.request(
    { method: 'tools/list', params: {} },
    ListToolsResultSchema,
  )
  let rawTools: SdkMcpTool[] = response.tools ?? []
  if (server.name === 'ide') {
    rawTools = rawTools.filter(t => ALLOWED_IDE_TOOLS.has(t.name))
  }

  const stripSdkPrefix =
    server.config.type === 'sdk' &&
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX)

  return rawTools.map(sdkTool =>
    createMcpToolInstance({
      server,
      sdkTool,
      qualifiedName: stripSdkPrefix
        ? sdkTool.name
        : buildMcpToolName(server.name, sdkTool.name),
      inputJsonSchema: sdkTool.inputSchema as ToolInputJsonSchema,
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
      genericInputSchema: z.record(z.string(), z.unknown()),
    }),
  )
}

/**
 * Memoized `tools/list` fetcher for a connected MCP server.
 */
export const fetchToolsForClient = memoize(
  fetchToolsForClientImpl,
  (server: ConnectedMcpServer) => server.name,
)

async function fetchResourcesForClientImpl(
  server: ConnectedMcpServer,
): Promise<ServerResource[]> {
  if (!server.capabilities?.resources) {
    return []
  }
  const res = await server.client.request(
    { method: 'resources/list', params: {} },
    ListResourcesResultSchema,
  )
  return (res.resources ?? []).map(item => ({
    ...item,
    server: server.name,
  }))
}

/**
 * Memoized `resources/list` fetcher for a connected MCP server.
 */
export const fetchResourcesForClient = memoize(
  fetchResourcesForClientImpl,
  (server: ConnectedMcpServer) => server.name,
)

async function fetchCommandsForClientImpl(
  server: ConnectedMcpServer,
): Promise<Command[]> {
  if (!server.capabilities?.prompts) {
    return []
  }
  const res = await server.client.request(
    { method: 'prompts/list', params: {} },
    ListPromptsResultSchema,
  )
  return (res.prompts ?? []).map(prompt => {
    const argNames = prompt.arguments?.map(a => a.name) ?? []
    const cmd: Command = {
      type: 'prompt',
      name: `mcp__${normalizeNameForMcp(server.name)}__${prompt.name}`,
      userFacingName: () => `${server.name}:${prompt.name} (MCP)`,
      description:
        prompt.description ?? `MCP prompt "${prompt.name}" from ${server.name}`,
      hasUserSpecifiedDescription: Boolean(prompt.description),
      isMcp: true,
      loadedFrom: 'mcp',
      source: 'mcp',
      progressMessage: `Running ${server.name}:${prompt.name}…`,
      contentLength: (prompt.description ?? '').length,
      argNames,
      argumentHint:
        argNames.length > 0 ? argNames.map(a => `<${a}>`).join(' ') : undefined,
      async getPromptForCommand(rawArgs: string) {
        const values = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : []
        const mappedArgs = zipObject(
          argNames,
          argNames.map((_, i) => values[i] ?? ''),
        )
        const promptResult = await server.client.getPrompt({
          name: prompt.name,
          arguments: mappedArgs,
        })
        const blocks: ContentBlockParam[] = []
        for (const message of (promptResult.messages ?? []) as PromptMessage[]) {
          const transformed = await transformMcpContentBlocks([message.content])
          blocks.push(...transformed)
        }
        return blocks.length > 0
          ? blocks
          : [{ type: 'text', text: `Invoked MCP prompt ${prompt.name}` }]
      },
    }
    return cmd
  })
}

/**
 * Memoized `prompts/list` -> slash `Command[]` builder for a connected MCP server.
 */
export const fetchCommandsForClient = memoize(
  fetchCommandsForClientImpl,
  (server: ConnectedMcpServer) => server.name,
)

/**
 * Clears all memoized connection, tool, resource, and prompt caches for `name`.
 */
export function clearServerCache(
  name: string,
  config: ScopedMcpServerConfig,
): void {
  connectToServer.cache.delete(getServerCacheKey(name, config))
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
}

/**
 * Disconnects, clears caches, and reconnects a single MCP server, returning its
 * fresh connection, tools, commands, and resources.
 */
export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{
  client: McpServerConnection
  tools: AnyTool[]
  commands: Command[]
  resources: ServerResource[]
}> {
  const existing = activeConnections.get(name)
  if (existing) {
    await existing.cleanup().catch(() => {})
  }
  clearMcpAuthCache(name, config)
  clearServerCache(name, config)

  const client = await connectToServer(name, config)
  if (client.type === 'connected') {
    const [tools, commands, resources] = await Promise.all([
      fetchToolsForClient(client).catch(() => []),
      fetchCommandsForClient(client).catch(() => []),
      fetchResourcesForClient(client).catch(() => []),
    ])
    return { client, tools, commands, resources }
  }
  if (
    client.type === 'needs-auth' &&
    (config.type === 'sse' || config.type === 'http') &&
    !isEnvFalsy(process.env.ENABLE_MCP_CLI_ENDPOINT)
  ) {
    return {
      client,
      tools: [asAnyTool(createMcpAuthTool(name, config))],
      commands: [],
      resources: [],
    }
  }
  return { client, tools: [], commands: [], resources: [] }
}

/**
 * Connects to all configured MCP servers using separate concurrency pools for
 * local (`stdio`/`sdk`, default 3) vs remote (`http`/`sse`/`ws`, default 20)
 * transports, injecting `McpAuthTool` for `needs-auth` servers and resource
 * tools when any server exposes `capabilities.resources`.
 */
export async function getMcpToolsCommandsAndResources(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
  onConnectionAttempt?: (connection: McpServerConnection) => void,
): Promise<{
  clients: McpServerConnection[]
  tools: AnyTool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
}> {
  const entries = Object.entries(mcpConfigs)
  const localEntries = entries.filter(
    ([, cfg]) => !cfg.type || cfg.type === 'stdio' || cfg.type === 'sdk',
  )
  const remoteEntries = entries.filter(
    ([, cfg]) => cfg.type && cfg.type !== 'stdio' && cfg.type !== 'sdk',
  )

  const localConcurrency =
    Number(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE) || 3
  const remoteConcurrency =
    Number(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE) || 20

  const clients: McpServerConnection[] = []
  const tools: AnyTool[] = []
  const commands: Command[] = []
  const resources: Record<string, ServerResource[]> = {}
  let hasResourceServer = false

  const handleEntry = async ([name, cfg]: [
    string,
    ScopedMcpServerConfig,
  ]): Promise<void> => {
    const conn = await connectToServer(name, cfg)
    clients.push(conn)
    onConnectionAttempt?.(conn)

    if (conn.type === 'connected') {
      const [serverTools, serverCommands, serverResources] = await Promise.all([
        fetchToolsForClient(conn).catch(() => []),
        fetchCommandsForClient(conn).catch(() => []),
        fetchResourcesForClient(conn).catch(() => []),
      ])
      tools.push(...serverTools)
      commands.push(...serverCommands)
      if (conn.capabilities?.resources || serverResources.length > 0) {
        hasResourceServer = true
        resources[name] = serverResources
      }
    } else if (
      conn.type === 'needs-auth' &&
      (cfg.type === 'sse' || cfg.type === 'http') &&
      !isEnvFalsy(process.env.ENABLE_MCP_CLI_ENDPOINT)
    ) {
      tools.push(asAnyTool(createMcpAuthTool(name, cfg)))
    }
  }

  await Promise.all([
    pMap(localEntries, handleEntry, { concurrency: localConcurrency }),
    pMap(remoteEntries, handleEntry, { concurrency: remoteConcurrency }),
  ])

  if (hasResourceServer) {
    tools.push(asAnyTool(ListMcpResourcesTool), asAnyTool(ReadMcpResourceTool))
  }

  return { clients, tools, commands, resources }
}

/**
 * Executes an MCP `tools/call` request with progress forwarding and `-32042`
 * URL elicitation retry support.
 */
export async function callMcpToolWithUrlElicitationRetry(params: {
  server: ConnectedMcpServer
  toolName: string
  args: Record<string, unknown>
  signal?: AbortSignal
  onProgress?: (progress: {
    progress: number
    total?: number
    message?: string
  }) => void
  onUrlElicitation?: (url: string, message: string) => Promise<boolean>
}): Promise<CallToolResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rawResult = await params.server.client.request(
        {
          method: 'tools/call',
          params: {
            name: params.toolName,
            arguments: params.args,
          },
        },
        CallToolResultSchema,
        {
          signal: params.signal,
          onprogress: progressEv => {
            params.onProgress?.({
              progress: progressEv.progress,
              total: progressEv.total,
              message: progressEv.message,
            })
          },
        },
      )
      return rawResult
    } catch (error) {
      if (isMcpSessionExpiredError(error)) {
        throw new McpSessionExpiredError(params.server.name)
      }
      if (
        error instanceof McpError &&
        error.code === URL_ELICITATION_REQUIRED_CODE &&
        params.onUrlElicitation &&
        attempt < 2
      ) {
        const errData =
          error.data && typeof error.data === 'object'
            ? (error.data as { url?: unknown })
            : {}
        const url = typeof errData.url === 'string' ? errData.url : ''
        if (url) {
          const accepted = await params.onUrlElicitation(url, error.message)
          if (accepted) {
            continue
          }
        }
      }
      throw error
    }
  }
  throw new Error(`MCP tool "${params.toolName}" exceeded URL elicitation retries`)
}

export const callMCPToolWithUrlElicitationRetry =
  callMcpToolWithUrlElicitationRetry

/**
 * Returns the active `ConnectedMcpServer` for `serverName`, if connected.
 */
export function getConnectedMcpServer(
  serverName: string,
  contextClients?: readonly unknown[],
): ConnectedMcpServer | undefined {
  if (contextClients) {
    for (const candidate of contextClients) {
      if (
        candidate &&
        typeof candidate === 'object' &&
        (candidate as { name?: unknown }).name === serverName &&
        (candidate as { type?: unknown }).type === 'connected' &&
        'client' in candidate
      ) {
        return candidate as ConnectedMcpServer
      }
    }
  }
  return activeConnections.get(serverName)
}

/**
 * Disconnects all active MCP clients and clears connection caches.
 */
export async function cleanupAllMcpClients(): Promise<void> {
  const entries = Array.from(activeConnections.values())
  activeConnections.clear()
  connectToServer.cache.clear?.()
  fetchToolsForClient.cache.clear?.()
  fetchResourcesForClient.cache.clear?.()
  fetchCommandsForClient.cache.clear?.()
  await Promise.allSettled(entries.map(conn => conn.cleanup()))
}
