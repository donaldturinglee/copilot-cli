/**
 * Bundled `/batch` skill orchestrating parallel isolated worktree migrations/refactors.
 */

import type { BundledSkillDefinition } from '../../types/forward.js'

export const batchBundledSkill: BundledSkillDefinition = {
  name: 'batch',
  description: 'Plan and execute large-scale parallel changes across isolated git worktrees',
  argumentHint: '<migration-goal>',
  disableModelInvocation: true,
  async getPromptForCommand(args) {
    return [
      {
        type: 'text',
        text: `Plan a parallelizable batch change across independent modules using isolated worktrees, verify one representative slice first, then fan out across remaining slices.\n\nGoal: ${args.trim() || '(ask the user for the batch goal)'}`,
      },
    ]
  },
}
