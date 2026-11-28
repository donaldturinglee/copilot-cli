/**
 * Slash command registration for `/skills`.
 */

import type { Command } from '../../types/command.js'

export const skillsSlashCommand: Command = {
  type: 'local-jsx',
  name: 'skills',
  description: 'List available project, user, bundled, plugin, and MCP skills',
  immediate: true,
  load: async () => import('./skills.js'),
}
