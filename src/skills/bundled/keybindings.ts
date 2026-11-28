/**
 * Bundled `keybindings-help` skill for customizing `~/.copilot/keybindings.json`.
 */

import type { BundledSkillDefinition } from '../../types/forward.js'

export const keybindingsBundledSkill: BundledSkillDefinition = {
  name: 'keybindings-help',
  description: 'Configure chorded contextual shortcuts in ~/.copilot/keybindings.json',
  userInvocable: false,
  allowedTools: ['Read'],
  async getPromptForCommand(args) {
    return [
      {
        type: 'text',
        text: `Guide the user in editing \`~/.copilot/keybindings.json\` using context-scoped chord bindings (e.g. \`{ "context": "Chat", "bindings": { "ctrl+x ctrl+e": "chat:externalEditor" } }\`).${args.trim() ? `\n\nUser request: ${args.trim()}` : ''}`,
      },
    ]
  },
}
