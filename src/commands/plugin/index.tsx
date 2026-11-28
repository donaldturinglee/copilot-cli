/**
 * Slash command registration for `/plugin` (aliases `/plugins`, `/marketplace`).
 */

import type { Command } from '../../types/command.js'

export const pluginSlashCommand: Command = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: 'Discover, install, manage, and validate Copilot CLI plugins and marketplaces',
  argumentHint: '[install|uninstall|enable|disable|validate|marketplace] [target]',
  immediate: true,
  load: async () => import('./plugin.js'),
}
