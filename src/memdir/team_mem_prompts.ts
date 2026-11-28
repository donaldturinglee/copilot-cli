/**
 * Combined personal + team memory system prompt builder
 * (`src/memdir/team_mem_prompts.ts`).
 */

import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_COMBINED,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './memory_types.js'
import { getAutoMemPath } from './paths.js'
import { getTeamMemPath } from './team_mem_paths.js'

export const DIRS_EXIST_GUIDANCE =
  'Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for its existence).'

/**
 * Builds combined private + team memory instructions when `TEAMMEM` is active.
 */
export function buildCombinedMemoryPrompt(
  extraGuidelines?: string,
  skipIndex = false,
): string {
  const autoDir = getAutoMemPath()
  const teamDir = getTeamMemPath()

  const lines: string[] = [
    '# Persistent Memory (Private & Team)',
    '',
    `Private auto-memory directory: \`${autoDir}\``,
    `Shared team memory directory: \`${teamDir}\``,
    DIRS_EXIST_GUIDANCE,
    '',
    '## Memory scope',
    '- Save private personal preferences and user context in the private auto-memory directory.',
    '- Save shared project decisions, conventions, and external references in the shared team memory directory.',
    '- NEVER write secrets, API keys, tokens, passwords, private keys, or personal credentials into team memory.',
    '',
    TYPES_SECTION_COMBINED,
    '',
    WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## How to save memories',
    'Step 1: Write a topic markdown file with YAML frontmatter:',
    '```markdown',
    MEMORY_FRONTMATTER_EXAMPLE,
    '```',
  ]

  if (!skipIndex) {
    lines.push(
      'Step 2: Add a single-line pointer under ~150 characters (`- [Title](file.md) — one-line hook`) to the corresponding `MEMORY.md` index (do not add YAML frontmatter to `MEMORY.md`).',
    )
  }

  lines.push('', WHEN_TO_ACCESS_SECTION, '', TRUSTING_RECALL_SECTION)

  if (extraGuidelines?.trim()) {
    lines.push('', extraGuidelines.trim())
  }

  return lines.join('\n')
}
