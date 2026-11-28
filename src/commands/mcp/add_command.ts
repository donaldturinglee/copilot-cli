/**
 * Option parsing and builder helpers for `copilot mcp add`.
 */

import { saveMcpClientSecret } from '../../services/mcp/auth.js'
import { addMcpConfig } from '../../services/mcp/config.js'
import type { McpServerConfig } from '../../services/mcp/types.js'

export interface McpAddCliOptions {
  scope?: string
  transport?: string
  env?: string[]
  header?: string[]
  clientId?: string
  clientSecret?: string
  callbackPort?: string | number
  xaa?: boolean
}

function parseKeyValuePairs(
  entries: readonly string[] | undefined,
  separator: '=' | ':',
): Record<string, string> | undefined {
  if (!entries || entries.length === 0) {
    return undefined
  }
  const result: Record<string, string> = {}
  for (const raw of entries) {
    const idx = raw.indexOf(separator)
    if (idx <= 0) {
      throw new Error(
        `Invalid ${separator === '=' ? 'env' : 'header'} entry "${raw}" (expected KEY${separator}VALUE)`,
      )
    }
    const key = raw.slice(0, idx).trim()
    const val = raw.slice(idx + 1).trim()
    result[key] = val
  }
  return result
}

/**
 * Validates and persists a server configuration from `copilot mcp add`.
 */
export function executeMcpAddCommand(
  name: string,
  commandOrUrl: string,
  args: readonly string[],
  options: McpAddCliOptions,
): { scope: 'local' | 'user' | 'project'; config: McpServerConfig } {
  const scopeRaw = (options.scope ?? 'local').toLowerCase()
  if (scopeRaw !== 'local' && scopeRaw !== 'user' && scopeRaw !== 'project') {
    throw new Error(
      `Invalid --scope "${options.scope}". Must be one of: local, user, project.`,
    )
  }
  const scope = scopeRaw

  const isUrl =
    commandOrUrl.startsWith('http://') || commandOrUrl.startsWith('https://')
  const transport = (
    options.transport ?? (isUrl ? 'http' : 'stdio')
  ).toLowerCase()

  let config: McpServerConfig
  if (transport === 'stdio') {
    const env = parseKeyValuePairs(options.env, '=')
    config = {
      type: 'stdio',
      command: commandOrUrl,
      ...(args.length > 0 ? { args: [...args] } : {}),
      ...(env ? { env } : {}),
    }
  } else if (transport === 'sse' || transport === 'http') {
    const headers = parseKeyValuePairs(options.header, ':')
    const portNum =
      options.callbackPort !== undefined
        ? Number(options.callbackPort)
        : undefined
    const oauth =
      options.clientId || portNum || options.xaa
        ? {
            ...(options.clientId ? { clientId: options.clientId } : {}),
            ...(portNum && Number.isInteger(portNum) && portNum > 0
              ? { callbackPort: portNum }
              : {}),
            ...(options.xaa ? { xaa: true } : {}),
          }
        : undefined
    config = {
      type: transport,
      url: commandOrUrl,
      ...(headers ? { headers } : {}),
      ...(oauth ? { oauth } : {}),
    }
  } else {
    throw new Error(
      `Invalid --transport "${transport}". Expected stdio, http, or sse.`,
    )
  }

  addMcpConfig(name, config, scope)
  if (options.clientSecret && (config.type === 'http' || config.type === 'sse')) {
    saveMcpClientSecret(name, config, options.clientSecret, options.clientId)
  }

  return { scope, config }
}
