/**
 * Bundled `/remember` skill auditing `INSTRUCTIONS.md`, `INSTRUCTIONS.local.md`,
 * and persistent `memdir` memories.
 */

import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import type { BundledSkillDefinition } from '../../types/forward.js'

export const rememberBundledSkill: BundledSkillDefinition = {
  name: 'remember',
  description: 'Save or audit durable conventions across INSTRUCTIONS.md, INSTRUCTIONS.local.md, and AutoMem',
  argumentHint: '[fact-or-rule]',
  isEnabled: () => isAutoMemoryEnabled(),
  async getPromptForCommand(args) {
    const memPath = getAutoMemPath()
    return [
      {
        type: 'text',
        text: `Audit \`INSTRUCTIONS.md\`, \`INSTRUCTIONS.local.md\`, and persistent memory at \`${memPath}\` for promotions, duplicates, or outdated notes.${args.trim() ? `\n\nNote to remember: ${args.trim()}` : ''}`,
      },
    ]
  },
}
