/**
 * String formatting, prefixing, and parsing utilities for `mcp__server__tool`
 * qualified identifiers.
 */

import { normalizeNameForMcp } from './normalization.js'

/**
 * Builds the `mcp__<normalizedServer>__` prefix for a server.
 */
export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__`
}

/**
 * Builds a canonical `mcp__<server>__<tool>` tool identifier.
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMcp(toolName)}`
}

/**
 * Parses `mcp__<server>__<tool>` into `{ serverName, toolName }`, or `null` if
 * `toolString` is not an MCP-prefixed identifier.
 */
export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  if (!toolString.startsWith('mcp__')) {
    return null
  }
  const rest = toolString.slice('mcp__'.length)
  if (!rest) {
    return null
  }
  const sepIdx = rest.indexOf('__')
  if (sepIdx === -1) {
    return { serverName: rest, toolName: undefined }
  }
  const serverName = rest.slice(0, sepIdx)
  const toolName = rest.slice(sepIdx + 2)
  if (!serverName) {
    return null
  }
  return {
    serverName,
    toolName: toolName.length > 0 ? toolName : undefined,
  }
}

/**
 * Reconstructs the canonical `mcp__<server>__<tool>` permission rule target
 * even when `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` stripped the prefix from `tool.name`.
 */
export function getToolNameForPermissionCheck(tool: {
  readonly name: string
  readonly mcpInfo?: { readonly serverName: string; readonly toolName: string }
}): string {
  if (tool.mcpInfo) {
    return buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
  }
  return tool.name
}

/**
 * Strips the `mcp__<server>__` prefix from a full MCP tool name for display.
 */
export function getMcpDisplayName(
  fullName: string,
  serverName: string,
): string {
  const prefix = getMcpPrefix(serverName)
  if (fullName.startsWith(prefix)) {
    return fullName.slice(prefix.length)
  }
  return fullName
}

/**
 * Strips `<server> - ` prefix and ` (MCP)` suffix from a user-facing MCP name.
 */
export function extractMcpToolDisplayName(userFacingName: string): string {
  let cleaned = userFacingName.endsWith(' (MCP)')
    ? userFacingName.slice(0, -' (MCP)'.length)
    : userFacingName
  const dashIdx = cleaned.indexOf(' - ')
  if (dashIdx !== -1) {
    cleaned = cleaned.slice(dashIdx + 3)
  }
  return cleaned
}
