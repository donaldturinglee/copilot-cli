/**
 * Bundled `/simplify` skill reviewing recent changes for code reuse, quality,
 * and efficiency.
 */

import type { BundledSkillDefinition } from '../../types/forward.js'

export const simplifyBundledSkill: BundledSkillDefinition = {
  name: 'simplify',
  description: 'Review modified code for reuse opportunities, simplicity, and performance',
  argumentHint: '[target-files]',
  async getPromptForCommand(args) {
    return [
      {
        type: 'text',
        text: `Inspect recent changes (\`git diff\`) across three angles — Reuse, Code Quality, and Efficiency — and simplify redundant or over-engineered code without changing behavior.${args.trim() ? `\n\nScope: ${args.trim()}` : ''}`,
      },
    ]
  },
}
