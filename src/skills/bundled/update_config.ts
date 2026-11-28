/**
 * Bundled `/update-config` skill guiding configuration of `.copilot/settings.json`
 * and hooks.
 */

import type { BundledSkillDefinition } from '../../types/forward.js'
import { SettingsSchema } from '../../utilities/settings/types.js'
import { zodToJsonSchema } from '../../utilities/zod_to_json_schema.js'

export const updateConfigBundledSkill: BundledSkillDefinition = {
  name: 'update-config',
  description: 'Inspect or update ~/.copilot/settings.json, .copilot/settings.json, and lifecycle hooks',
  argumentHint: '[hooks-only | setting-description]',
  allowedTools: ['Read'],
  async getPromptForCommand(args) {
    const schemaSummary = JSON.stringify(
      zodToJsonSchema(SettingsSchema()),
    ).slice(0, 4000)
    const body = `Help the user configure Copilot CLI settings (\`~/.copilot/settings.json\`, \`.copilot/settings.json\`, \`.copilot/settings.local.json\`).\n\nSettings JSON Schema excerpt:\n\`\`\`json\n${schemaSummary}\n\`\`\`${args.trim() ? `\n\nRequest: ${args.trim()}` : ''}`
    return [{ type: 'text', text: body }]
  },
}
