/**
 * Slash command registration for `/reload-plugins`.
 */

import type { Command } from '../../types/command.js'

export const reloadPluginsSlashCommand: Command = {
  type: 'local',
  name: 'reload-plugins',
  description: 'Reload installed plugins, skills, agents, hooks, MCP, and LSP servers',
  supportsNonInteractive: false,
  immediate: true,
  load: async () => import('./reload_plugins.js'),
}
