/**
 * Bundled `/verify` skill registration with extracted `examples/*.md` files.
 */

import type { BundledSkillDefinition } from '../../types/forward.js'
import { VERIFY_SKILL_FILES, VERIFY_SKILL_MD } from './verify_content.js'

export const verifyBundledSkill: BundledSkillDefinition = {
  name: 'verify',
  description: 'Verify changes end-to-end with real build, test, and runtime checks',
  whenToUse: 'When verifying recent code edits before finishing or committing',
  argumentHint: '[focus-area]',
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell'],
  files: { ...VERIFY_SKILL_FILES },
  async getPromptForCommand(args) {
    const text = args.trim()
      ? `${VERIFY_SKILL_MD}\n\nFocus area: ${args.trim()}`
      : VERIFY_SKILL_MD
    return [{ type: 'text', text }]
  },
}
