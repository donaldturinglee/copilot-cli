/**
 * Bundled `/debug` skill inspecting settings paths and recent debug diagnostics.
 */

import { join } from 'path'
import type { BundledSkillDefinition } from '../../types/forward.js'
import { getCwd } from '../../utilities/cwd.js'
import { getClaudeConfigHomeDir } from '../../utilities/env_utils.js'
import { getInMemoryErrors } from '../../utilities/log.js'

export const debugBundledSkill: BundledSkillDefinition = {
  name: 'debug',
  description: 'Diagnose Copilot CLI configuration, hooks, MCP servers, and recent errors',
  argumentHint: '[issue-description]',
  disableModelInvocation: true,
  allowedTools: ['Read', 'Grep', 'Glob'],
  async getPromptForCommand(args) {
    const recentErrors = getInMemoryErrors()
      .slice(-20)
      .map(e => `[${e.timestamp}] ${e.error}`)
      .join('\n')
    const info = [
      `User config dir: ${getClaudeConfigHomeDir()}`,
      `Project config dir: ${join(getCwd(), '.copilot')}`,
      recentErrors ? `Recent in-memory errors:\n${recentErrors}` : 'Recent in-memory errors: none',
      args.trim() ? `Reported issue: ${args.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    return [
      {
        type: 'text',
        text: `Investigate the following Copilot CLI runtime diagnostics and help resolve the issue:\n\n${info}`,
      },
    ]
  },
}
