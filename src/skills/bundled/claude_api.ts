/**
 * Bundled `claude-api` SDK guidance skill with static reference docs extracted
 * on demand.
 */

import type { BundledSkillDefinition } from '../../types/forward.js'
import {
  CLAUDE_API_SKILL_FILES,
  CLAUDE_API_SKILL_PROMPT,
} from './claude_api_content.js'

function interpolateModelVars(text: string): string {
  return text
    .replace(/\{\{OPUS_ID\}\}/g, 'claude-opus-4-6')
    .replace(/\{\{SONNET_ID\}\}/g, 'claude-sonnet-4-6')
    .replace(/\{\{HAIKU_ID\}\}/g, 'claude-haiku-4-5-20251001')
}

export const claudeApiBundledSkill: BundledSkillDefinition = {
  name: 'claude-api',
  description: 'Build LLM applications with the Anthropic / Claude SDK and Messages API',
  whenToUse: 'When writing code using @anthropic-ai/sdk, anthropic Python SDK, or Messages API',
  allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch'],
  files: Object.fromEntries(
    Object.entries(CLAUDE_API_SKILL_FILES).map(([k, v]) => [
      k,
      interpolateModelVars(v),
    ]),
  ),
  async getPromptForCommand(args) {
    const base = interpolateModelVars(CLAUDE_API_SKILL_PROMPT)
    const full = args.trim() ? `${base}\n\nTask: ${args.trim()}` : base
    return [{ type: 'text', text: full }]
  },
}
