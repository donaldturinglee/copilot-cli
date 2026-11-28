/**
 * Computes prompt-cache-safe delta attachments for newly connected MCP servers
 * that advertise `instructions` mid-session without mutating the initial
 * system prompt prefix.
 */

import type { McpServerConnection } from '../services/mcp/types.js'
import type { Message } from '../types/message.js'

export interface McpInstructionDeltaItem {
  serverName: string
  instructions: string
}

/**
 * Returns MCP server instructions that have not yet been surfaced in either the
 * initial system prompt (`initialServerNames`) or prior `mcp_instructions_delta`
 * attachment messages.
 */
export function getMcpInstructionsDelta(
  mcpClients: readonly McpServerConnection[],
  messages: readonly Message[],
  initialServerNames?: ReadonlySet<string>,
): McpInstructionDeltaItem[] {
  const alreadySent = new Set<string>(initialServerNames ?? [])

  for (const msg of messages) {
    if (
      msg.type === 'attachment' &&
      msg.attachment.type === 'mcp_instructions_delta' &&
      Array.isArray(msg.attachment.servers)
    ) {
      for (const entry of msg.attachment.servers as Array<{
        serverName?: unknown
      }>) {
        if (typeof entry.serverName === 'string') {
          alreadySent.add(entry.serverName)
        }
      }
    }
  }

  const delta: McpInstructionDeltaItem[] = []
  for (const client of mcpClients) {
    if (
      client.type === 'connected' &&
      typeof client.instructions === 'string' &&
      client.instructions.trim().length > 0 &&
      !alreadySent.has(client.name)
    ) {
      delta.push({
        serverName: client.name,
        instructions: client.instructions.trim(),
      })
    }
  }

  return delta
}
