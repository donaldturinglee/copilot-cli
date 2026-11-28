/**
 * Fetches remote `claude.ai` MCP proxy server configurations when an OAuth
 * session carries the `user:mcp_servers` scope.
 */

import memoize from 'lodash-es/memoize.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utilities/debug.js'
import { isEnvFalsy } from '../../utilities/env_utils.js'
import { getSecureStorage } from '../../utilities/secure_storage/index.js'
import type { ScopedMcpServerConfig } from './types.js'

const CLAUDE_AI_MCP_BETA_HEADER = 'mcp-servers-2025-12-04'
const FETCH_TIMEOUT_MS = 5_000

interface ClaudeAiMcpServerItem {
  id: string
  display_name?: string
  name?: string
  url?: string
}

async function fetchClaudeAiMcpConfigsImpl(): Promise<
  Record<string, ScopedMcpServerConfig>
> {
  if (isEnvFalsy(process.env.ENABLE_CLAUDEAI_MCP_SERVERS)) {
    return {}
  }
  const oauthTokens = getSecureStorage().read()?.claudeAiOauth
  if (
    !oauthTokens?.accessToken ||
    !oauthTokens.scopes?.includes('user:mcp_servers')
  ) {
    return {}
  }

  const oauthConfig = getOauthConfig()
  const endpoint = `${oauthConfig.BASE_API_URL.replace(/\/+$/, '')}/v1/mcp_servers?limit=1000`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  timer.unref?.()

  try {
    const res = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'anthropic-beta': CLAUDE_AI_MCP_BETA_HEADER,
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      return {}
    }
    const payload = (await res.json()) as { data?: ClaudeAiMcpServerItem[] }
    const items = Array.isArray(payload.data) ? payload.data : []
    const servers: Record<string, ScopedMcpServerConfig> = {}
    for (const item of items) {
      if (!item.id) continue
      const label = item.display_name ?? item.name ?? item.id
      const serverName = `claude.ai ${label}`
      servers[serverName] = {
        type: 'claudeai-proxy',
        id: item.id,
        url: item.url ?? oauthConfig.MCP_PROXY_URL,
        scope: 'claudeai',
      }
    }
    return servers
  } catch (error) {
    logForDebugging(
      `Failed to fetch claude.ai MCP servers: ${error instanceof Error ? error.message : String(error)}`,
    )
    return {}
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Memoized fetcher for `claude.ai` remote MCP connectors.
 */
export const fetchClaudeAiMcpConfigs = memoize(fetchClaudeAiMcpConfigsImpl)
export const fetchClaudeAIMcpConfigs = fetchClaudeAiMcpConfigs

/**
 * Clears the memoized `claude.ai` MCP connector cache.
 */
export function clearClaudeAiMcpConfigsCache(): void {
  fetchClaudeAiMcpConfigs.cache.clear?.()
}
export const clearClaudeAIMcpConfigsCache = clearClaudeAiMcpConfigsCache
