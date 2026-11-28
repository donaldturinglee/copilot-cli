/**
 * Bundled `/skillify` skill turning a repeatable session workflow into a
 * reusable `.copilot/skills/<name>/SKILL.md` skill.
 */

import { getSessionMemoryContent } from '../../services/session_memory/session_memory_utils.js'
import type { BundledSkillDefinition } from '../../types/forward.js'

export const skillifyBundledSkill: BundledSkillDefinition = {
  name: 'skillify',
  description: 'Capture a workflow from the current session into a reusable .copilot/skills/<name>/SKILL.md skill',
  argumentHint: '[skill-name]',
  disableModelInvocation: true,
  async getPromptForCommand(args) {
    const summary = (await getSessionMemoryContent().catch(() => null)) ?? ''
    return [
      {
        type: 'text',
        text: `Synthesize the repeatable workflow from this session into a concise \`.copilot/skills/<name>/SKILL.md\` (or \`~/.copilot/skills/<name>/SKILL.md\`) with clear YAML frontmatter (\`name\`, \`description\`, \`when_to_use\`, \`argument-hint\`).${args.trim() ? `\n\nRequested name/hint: ${args.trim()}` : ''}${summary ? `\n\nSession summary context:\n${summary}` : ''}`,
      },
    ]
  },
}
