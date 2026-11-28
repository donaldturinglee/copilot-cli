/**
 * VS Code SDK MCP bridge helpers for notifying connected IDE servers of file
 * updates.
 */

import type { ConnectedMcpServer, McpServerConnection } from './types.js'

let activeIdeClient: ConnectedMcpServer | null = null

/**
 * Registers the connected `ide` SDK/SSE/WS MCP client if present.
 */
export function setupVscodeSdkMcp(
  clients: readonly McpServerConnection[],
): void {
  const found = clients.find(
    (c): c is ConnectedMcpServer => c.name === 'ide' && c.type === 'connected',
  )
  activeIdeClient = found ?? null
}

/**
 * Sends a best-effort `fileUpdated` notification to a connected VS Code IDE MCP
 * server.
 */
export async function notifyVscodeFileUpdated(
  filePath: string,
  content: string,
): Promise<void> {
  if (!activeIdeClient) {
    return
  }
  try {
    await activeIdeClient.client.notification({
      method: 'notifications/claude/fileUpdated',
      params: { filePath, content },
    })
  } catch {
    // Ignore unsupported notification errors
  }
}
