/**
 * Prompt builder and 1% context-window skill listing formatter for `SkillTool`.
 * Bundled skills are never truncated; user/project/plugin skills degrade
 * gracefully when total listing width exceeds the budget.
 */

import { stringWidth } from '../../ink/string_width.js'
import { getCommandName, type Command } from '../../types/command.js'
import {
  DEFAULT_SKILL_CHAR_BUDGET,
  MAX_SKILL_LISTING_DESC_CHARS,
  MIN_SKILL_DESC_LENGTH,
  SKILL_BUDGET_CONTEXT_PERCENT,
  SKILL_CHARS_PER_TOKEN,
} from './constants.js'

export const SKILL_TOOL_DESCRIPTION =
  'Execute a specialized skill or prompt workflow within the conversation.'

export const SKILL_TOOL_BASE_PROMPT = `Execute a skill within the main conversation or an isolated forked subagent.
When the user's task matches an available skill's description or when a user references \`/<skill-name>\`, invoke \`Skill\` with \`skill\` (and optional \`args\`).`

/**
 * Computes the character budget for skill listings (1% of context window in chars,
 * overridable via `COPILOT_CLI_SKILL_CHAR_BUDGET` or `SLASH_COMMAND_TOOL_CHAR_BUDGET`).
 */
export function getSkillCharBudget(contextWindowTokens?: number): number {
  const override = Number(
    process.env.COPILOT_CLI_SKILL_CHAR_BUDGET ??
      process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET,
  )
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  if (contextWindowTokens && contextWindowTokens > 0) {
    return Math.floor(
      contextWindowTokens * SKILL_CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_SKILL_CHAR_BUDGET
}

function buildFullDescription(cmd: Command): string {
  const raw = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return raw.length > MAX_SKILL_LISTING_DESC_CHARS
    ? `${raw.slice(0, MAX_SKILL_LISTING_DESC_CHARS - 3)}...`
    : raw
}

/**
 * Formats model-invocable skills within `getSkillCharBudget(contextWindowTokens)`.
 * Bundled skills (`source === 'bundled'`) keep their full descriptions; remaining
 * skills truncate proportionally or fall back to `- <name>` if budget is tight.
 */
export function formatCommandsWithinBudget(
  commands: readonly Command[],
  contextWindowTokens?: number,
): string {
  const eligible = commands.filter(
    cmd =>
      cmd.type === 'prompt' &&
      cmd.disableModelInvocation !== true &&
      (cmd.isEnabled?.() ?? true),
  )
  if (eligible.length === 0) {
    return ''
  }

  const budget = getSkillCharBudget(contextWindowTokens)
  const fullLines = eligible.map(
    cmd => `- ${getCommandName(cmd)}: ${buildFullDescription(cmd)}`,
  )
  const fullText = fullLines.join('\n')
  if (stringWidth(fullText) <= budget) {
    return fullText
  }

  const bundled = eligible.filter(
    cmd => cmd.type === 'prompt' && cmd.source === 'bundled',
  )
  const nonBundled = eligible.filter(
    cmd => !(cmd.type === 'prompt' && cmd.source === 'bundled'),
  )

  const bundledLines = bundled.map(
    cmd => `- ${getCommandName(cmd)}: ${buildFullDescription(cmd)}`,
  )
  const bundledChars = bundledLines.reduce((sum, l) => sum + l.length + 1, 0)

  if (nonBundled.length === 0) {
    return bundledLines.join('\n')
  }

  const remainingBudget = Math.max(0, budget - bundledChars)
  const avgNamePrefix =
    nonBundled.reduce((sum, c) => sum + getCommandName(c).length + 4, 0) /
    nonBundled.length
  const maxDescLen = Math.floor(
    remainingBudget / nonBundled.length - avgNamePrefix,
  )

  const nonBundledLines = nonBundled.map(cmd => {
    const name = getCommandName(cmd)
    if (maxDescLen < MIN_SKILL_DESC_LENGTH) {
      return `- ${name}`
    }
    const desc = buildFullDescription(cmd)
    const truncated =
      desc.length > maxDescLen
        ? `${desc.slice(0, Math.max(1, maxDescLen - 3))}...`
        : desc
    return `- ${name}: ${truncated}`
  })

  return [...bundledLines, ...nonBundledLines].join('\n')
}
