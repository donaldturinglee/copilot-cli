/**
 * Slash command registration for `/mcp`.
 */

import type { Command } from '../../types/command.js'

export const mcpSlashCommand: Command = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage MCP server connections, authentication, and tools',
  argumentHint: '[reconnect <name> | enable [name] | disable [name]]',
  immediate: true,
  load: async () => import('./mcp.js'),
}
