/**
 * Bundled `/loop` skill converting `[interval] <prompt>` into a recurring
 * session cron schedule.
 */

import { getScheduledTasksEnabled } from '../../bootstrap/state.js'
import type { BundledSkillDefinition } from '../../types/forward.js'

export const loopBundledSkill: BundledSkillDefinition = {
  name: 'loop',
  description: 'Run a prompt or slash command on a recurring interval (default 10m)',
  argumentHint: '[interval] <prompt>',
  isEnabled: () => getScheduledTasksEnabled(),
  async getPromptForCommand(args) {
    return [
      {
        type: 'text',
        text: `Parse the interval (defaulting to every 10 minutes if omitted) and schedule the recurring prompt using CronCreate:\n\nInput: ${args.trim()}`,
      },
    ]
  },
}
