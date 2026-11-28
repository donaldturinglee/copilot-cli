/**
 * Internal diagnostic bundled skills (`lorem-ipsum`, `stuck`, `schedule`, `claude-in-chrome`).
 */

import { getChromeFlagOverride } from '../../bootstrap/state.js'
import type { BundledSkillDefinition } from '../../types/forward.js'

export const loremIpsumBundledSkill: BundledSkillDefinition = {
  name: 'lorem-ipsum',
  description: 'Generate synthetic token-counted filler text for context-window testing',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  disableModelInvocation: true,
  async getPromptForCommand(args) {
    const count = Math.min(50_000, Math.max(10, Number(args.trim()) || 500))
    const filler = Array.from({ length: count }, (_, i) => `word${i}`).join(' ')
    return [{ type: 'text', text: filler }]
  },
}

export const stuckBundledSkill: BundledSkillDefinition = {
  name: 'stuck',
  description: 'Inspect hung or high-CPU CLI processes',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  disableModelInvocation: true,
  async getPromptForCommand(args) {
    return [
      {
        type: 'text',
        text: `Diagnose stalled subprocesses or event-loop contention.${args.trim() ? ` Target: ${args.trim()}` : ''}`,
      },
    ]
  },
}

export const scheduleRemoteAgentsBundledSkill: BundledSkillDefinition = {
  name: 'schedule',
  description: 'Create or manage scheduled remote agent triggers',
  isEnabled: () => Boolean(process.env.COPILOT_CLI_ENABLE_REMOTE_TRIGGERS),
  async getPromptForCommand(args) {
    return [
      {
        type: 'text',
        text: `Manage scheduled remote triggers using RemoteTrigger.${args.trim() ? ` Request: ${args.trim()}` : ''}`,
      },
    ]
  },
}

export const claudeInChromeBundledSkill: BundledSkillDefinition = {
  name: 'claude-in-chrome',
  description: 'Automate and inspect web pages via the Chrome MCP integration',
  isEnabled: () => getChromeFlagOverride() === true,
  async getPromptForCommand(args) {
    return [
      {
        type: 'text',
        text: `Use \`mcp__claude-in-chrome__*\` browser tools to complete the user's browser task.${args.trim() ? `\n\nTask: ${args.trim()}` : ''}`,
      },
    ]
  },
}
