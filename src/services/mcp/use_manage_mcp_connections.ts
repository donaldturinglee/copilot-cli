/**
 * React lifecycle hook managing live MCP server connections, 16ms micro-batched
 * state updates, dynamic `notifications/{tools,prompts,resources}/list_changed`
 * refreshes, elicitation handlers, and exponential backoff auto-reconnect.
 */

import {
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { useCallback, useEffect, useRef } from 'react'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../../state/app_state.js'
import type { Tool as ForwardTool } from '../../types/forward.js'
import { isBareMode } from '../../utilities/env_utils.js'
import { sleep } from '../../utilities/sleep.js'
import {
  cleanupAllMcpClients,
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getMcpToolsCommandsAndResources,
  reconnectMcpServerImpl,
} from './client.js'
import { getAllMcpConfigs, isMcpServerDisabled, setMcpServerEnabled } from './config.js'
import {
  completeElicitationById,
  createElicitationHandler,
} from './elicitation_handler.js'
import { getMcpPrefix } from './mcp_string_utils.js'
import type {
  ConnectedMcpServer,
  McpServerConnection,
  ScopedMcpServerConfig,
} from './types.js'

const MAX_AUTO_RECONNECT_ATTEMPTS = 5

export interface ReconnectResult {
  client: McpServerConnection
  toolCount: number
  error?: string
}

/**
 * Connects and maintains configured MCP servers inside a React session, wiring
 * `list_changed` notification handlers and reconnect helpers.
 */
export function useManageMcpConnections(
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>,
  strictMcpConfig?: boolean,
): {
  reconnectServer: (serverName: string) => Promise<ReconnectResult>
  toggleServerEnabled: (serverName: string) => Promise<void>
} {
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const authVersion = useAppState(s => s.authVersion)
  const pluginReconnectKey = useAppState(s => s.mcp.pluginReconnectKey)
  const configsRef = useRef<Record<string, ScopedMcpServerConfig>>({})
  const mountedRef = useRef(true)

  const attachNotificationHandlers = useCallback(
    (conn: ConnectedMcpServer) => {
      const elicitHandler = createElicitationHandler({
        serverName: conn.name,
        getAppState: () => store.getState(),
        setAppState,
      })
      conn.client.setRequestHandler(ElicitRequestSchema, request =>
        elicitHandler(request.params),
      )

      conn.client.setNotificationHandler(
        ElicitationCompleteNotificationSchema,
        notification => {
          const id = notification.params?.elicitationId
          if (typeof id === 'string') {
            completeElicitationById(setAppState, id)
          }
        },
      )

      if (conn.capabilities?.tools?.listChanged) {
        conn.client.setNotificationHandler(
          ToolListChangedNotificationSchema,
          async () => {
            fetchToolsForClient.cache.delete(conn.name)
            const freshTools = await fetchToolsForClient(conn).catch(() => [])
            const prefix = getMcpPrefix(conn.name)
            if (!mountedRef.current) return
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                tools: [
                  ...prev.mcp.tools.filter(t => !t.name.startsWith(prefix)),
                  ...(freshTools as unknown as ForwardTool[]),
                ],
              },
            }))
          },
        )
      }

      if (conn.capabilities?.prompts?.listChanged) {
        conn.client.setNotificationHandler(
          PromptListChangedNotificationSchema,
          async () => {
            fetchCommandsForClient.cache.delete(conn.name)
            const freshCommands = await fetchCommandsForClient(conn).catch(
              () => [],
            )
            const prefix = getMcpPrefix(conn.name)
            if (!mountedRef.current) return
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                commands: [
                  ...prev.mcp.commands.filter(c => !c.name.startsWith(prefix)),
                  ...freshCommands,
                ],
              },
            }))
          },
        )
      }

      if (conn.capabilities?.resources?.listChanged) {
        conn.client.setNotificationHandler(
          ResourceListChangedNotificationSchema,
          async () => {
            fetchResourcesForClient.cache.delete(conn.name)
            const freshResources = await fetchResourcesForClient(conn).catch(
              () => [],
            )
            if (!mountedRef.current) return
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                resources: {
                  ...prev.mcp.resources,
                  [conn.name]: freshResources,
                },
              },
            }))
          },
        )
      }
    },
    [setAppState, store],
  )

  const reconnectServer = useCallback(
    async (serverName: string): Promise<ReconnectResult> => {
      const cfg =
        configsRef.current[serverName] ??
        store
          .getState()
          .mcp.clients.find(c => c.name === serverName)?.config
      if (!cfg) {
        return {
          client: {
            name: serverName,
            type: 'failed',
            config: { command: '', scope: 'local' },
            error: `MCP server "${serverName}" is not configured`,
          },
          toolCount: 0,
          error: `MCP server "${serverName}" is not configured`,
        }
      }

      const scopedCfg = cfg as ScopedMcpServerConfig
      const result = await reconnectMcpServerImpl(serverName, scopedCfg)
      if (result.client.type === 'connected') {
        attachNotificationHandlers(result.client)
      }

      const prefix = getMcpPrefix(serverName)
      setAppState(prev => {
        const otherClients = prev.mcp.clients.filter(c => c.name !== serverName)
        return {
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: [...otherClients, result.client],
            tools: [
              ...prev.mcp.tools.filter(t => !t.name.startsWith(prefix)),
              ...(result.tools as unknown as ForwardTool[]),
            ],
            commands: [
              ...prev.mcp.commands.filter(c => !c.name.startsWith(prefix)),
              ...result.commands,
            ],
            resources: {
              ...prev.mcp.resources,
              [serverName]: result.resources,
            },
          },
        }
      })

      return {
        client: result.client,
        toolCount: result.tools.length,
        ...(result.client.type === 'failed'
          ? { error: result.client.error }
          : {}),
      }
    },
    [attachNotificationHandlers, setAppState, store],
  )

  const toggleServerEnabled = useCallback(
    async (serverName: string): Promise<void> => {
      const currentlyDisabled = isMcpServerDisabled(serverName)
      const nextEnabled = currentlyDisabled
      setMcpServerEnabled(serverName, nextEnabled)

      const cfg =
        configsRef.current[serverName] ??
        (store
          .getState()
          .mcp.clients.find(c => c.name === serverName)
          ?.config as ScopedMcpServerConfig | undefined)
      if (!cfg) {
        return
      }

      if (!nextEnabled) {
        const existing = store
          .getState()
          .mcp.clients.find(c => c.name === serverName)
        if (
          existing &&
          existing.type === 'connected' &&
          typeof existing.cleanup === 'function'
        ) {
          await (existing.cleanup as () => Promise<void>)().catch(() => {})
        }
        clearServerCache(serverName, cfg)
        const prefix = getMcpPrefix(serverName)
        setAppState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: prev.mcp.clients.map(c =>
              c.name === serverName
                ? { name: serverName, type: 'disabled', config: cfg }
                : c,
            ),
            tools: prev.mcp.tools.filter(t => !t.name.startsWith(prefix)),
            commands: prev.mcp.commands.filter(c => !c.name.startsWith(prefix)),
          },
        }))
        return
      }

      await reconnectServer(serverName)
    },
    [reconnectServer, setAppState, store],
  )

  useEffect(() => {
    mountedRef.current = true
    if (isBareMode() && !dynamicMcpConfig) {
      return () => {
        mountedRef.current = false
      }
    }

    let cancelled = false
    const loadAll = async () => {
      const resolved = await getAllMcpConfigs({
        dynamicMcpConfig,
        strictMcpConfig,
      })
      if (cancelled) return
      configsRef.current = resolved.servers
      if (Object.keys(resolved.servers).length === 0) {
        return
      }

      const connectedBatch = await getMcpToolsCommandsAndResources(
        resolved.servers,
      )
      if (cancelled) return

      for (const conn of connectedBatch.clients) {
        if (conn.type === 'connected') {
          attachNotificationHandlers(conn)
          const isRemote =
            conn.config.type === 'sse' ||
            conn.config.type === 'http' ||
            conn.config.type === 'ws' ||
            conn.config.type === 'claudeai-proxy'
          if (isRemote) {
            conn.client.onclose = () => {
              if (!mountedRef.current || isMcpServerDisabled(conn.name)) {
                return
              }
              void (async () => {
                for (
                  let attempt = 1;
                  attempt <= MAX_AUTO_RECONNECT_ATTEMPTS;
                  attempt++
                ) {
                  if (!mountedRef.current) return
                  setAppState(prev => ({
                    ...prev,
                    mcp: {
                      ...prev.mcp,
                      clients: prev.mcp.clients.map(c =>
                        c.name === conn.name
                          ? {
                              name: conn.name,
                              type: 'pending',
                              config: conn.config,
                              reconnectAttempt: attempt,
                              maxReconnectAttempts: MAX_AUTO_RECONNECT_ATTEMPTS,
                            }
                          : c,
                      ),
                    },
                  }))
                  await sleep(1000 * Math.pow(2, attempt - 1))
                  const res = await reconnectServer(conn.name)
                  if (res.client.type === 'connected') {
                    return
                  }
                }
              })()
            }
          }
        }
      }

      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: connectedBatch.clients,
          tools: connectedBatch.tools as unknown as ForwardTool[],
          commands: connectedBatch.commands,
          resources: connectedBatch.resources,
        },
      }))
    }

    void loadAll()
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [
    attachNotificationHandlers,
    authVersion,
    dynamicMcpConfig,
    pluginReconnectKey,
    reconnectServer,
    setAppState,
    strictMcpConfig,
  ])

  useEffect(() => {
    return () => {
      void cleanupAllMcpClients()
    }
  }, [])

  return { reconnectServer, toggleServerEnabled }
}

export const useManageMCPConnections = useManageMcpConnections
