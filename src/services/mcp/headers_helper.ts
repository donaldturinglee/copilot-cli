/**
 * Workspace-trust-gated `headersHelper` command execution for dynamic MCP
 * authentication headers.
 */

import { getIsInteractive, getSessionTrustAccepted } from '../../bootstrap/state.js'
import { getCurrentProjectConfig } from '../../utilities/config.js'
import { logForDebugging } from '../../utilities/debug.js'
import { findSuitableShell, exec as execShell } from '../../utilities/shell.js'
import type { ScopedMcpServerConfig } from './types.js'

const HEADERS_HELPER_TIMEOUT_MS = 10_000

type HeaderBearingConfig = Extract<
  ScopedMcpServerConfig,
  { type: 'sse' | 'http' | 'ws' }
>

function isHeaderBearingConfig(
  config: ScopedMcpServerConfig,
): config is HeaderBearingConfig {
  return (
    config.type === 'sse' || config.type === 'http' || config.type === 'ws'
  )
}

function isWorkspaceTrustedForHelper(): boolean {
  if (!getIsInteractive()) {
    return true
  }
  if (getSessionTrustAccepted()) {
    return true
  }
  try {
    return Boolean(getCurrentProjectConfig().hasTrustDialogAccepted)
  } catch {
    return false
  }
}

/**
 * Executes `config.headersHelper` if present and workspace trust permits it,
 * validating that stdout is a flat JSON object of string header values.
 */
export async function getMcpHeadersFromHelper(
  serverName: string,
  config: ScopedMcpServerConfig,
): Promise<Record<string, string> | null> {
  if (!isHeaderBearingConfig(config) || !config.headersHelper) {
    return null
  }

  if (
    (config.scope === 'project' || config.scope === 'local') &&
    !isWorkspaceTrustedForHelper()
  ) {
    logForDebugging(
      `Skipping headersHelper for MCP server "${serverName}" (${config.scope}) because workspace trust has not been accepted`,
      { level: 'warn' },
    )
    return null
  }

  try {
    const shellKind =
      process.platform === 'win32' && !findSuitableShell()
        ? 'powershell'
        : 'bash'
    const shellCmd = await execShell(
      config.headersHelper,
      undefined,
      shellKind,
      {
        timeoutMs: HEADERS_HELPER_TIMEOUT_MS,
        persistCwd: false,
        env: {
          ...process.env,
          CLAUDE_CODE_MCP_SERVER_NAME: serverName,
          CLAUDE_CODE_MCP_SERVER_URL: config.url,
          COPILOT_CLI_MCP_SERVER_NAME: serverName,
          COPILOT_CLI_MCP_SERVER_URL: config.url,
        },
      },
    )
    const result = await shellCmd.result
    if (result.code !== 0) {
      logForDebugging(
        `headersHelper for MCP server "${serverName}" exited with code ${result.code}: ${result.stderr}`,
        { level: 'warn' },
      )
      return null
    }
    const parsed: unknown = JSON.parse(result.stdout.trim())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logForDebugging(
        `headersHelper for MCP server "${serverName}" did not output a JSON object`,
        { level: 'warn' },
      )
      return null
    }
    const headers: Record<string, string> = {}
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val !== 'string') {
        logForDebugging(
          `headersHelper for MCP server "${serverName}" returned non-string header "${key}"`,
          { level: 'warn' },
        )
        return null
      }
      headers[key] = val
    }
    return headers
  } catch (error) {
    logForDebugging(
      `headersHelper failed for MCP server "${serverName}": ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Merges static `config.headers` with dynamic `headersHelper` output (dynamic
 * headers override static keys).
 */
export async function getMcpServerHeaders(
  serverName: string,
  config: ScopedMcpServerConfig,
): Promise<Record<string, string> | undefined> {
  if (!isHeaderBearingConfig(config)) {
    return undefined
  }
  const helperHeaders = await getMcpHeadersFromHelper(serverName, config)
  if (!config.headers && !helperHeaders) {
    return undefined
  }
  return {
    ...(config.headers ?? {}),
    ...(helperHeaders ?? {}),
  }
}
