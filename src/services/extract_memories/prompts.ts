/**
 * Prompt builders for Stop-hook background memory extraction
 * (`extractMemories`), supporting auto-only and combined private+team modes.
 */

import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from '../../memdir/memory_types.js'
import { ENTRYPOINT_NAME } from '../../memdir/memdir.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { getTeamMemPath } from '../../memdir/team_mem_paths.js'

function buildOpener(
  newMessageCount: number,
  existingMemories: string,
): string {
  const parts = [
    `Analyze the last ~${newMessageCount} messages of the conversation and extract durable memories worth saving across future sessions.`,
    '',
    'Tool constraints:',
    '- Permitted tools: Read, Grep, Glob, read-only Bash (ls/find/grep/cat/stat/wc/head/tail — NEVER Bash rm or writes), and Edit/Write strictly inside the memory directory.',
    '- Batch efficiently in at most 2 tool turns: Turn 1 = parallel Read calls to inspect existing memory files; Turn 2 = parallel Write/Edit calls to update or create topic files.',
    '- Do NOT read/grep repository source code or run git commands to verify code facts.',
    '- If the user explicitly asked to remember or forget something, honor it.',
  ]

  if (existingMemories.trim().length > 0) {
    parts.push('', '## Existing memory files', existingMemories.trim())
  }

  return parts.join('\n')
}

function buildSaveInstructions(skipIndex: boolean): string {
  const lines = [
    '## How to save memories',
    'Step 1: Write or update topic markdown files with YAML frontmatter:',
    '```markdown',
    MEMORY_FRONTMATTER_EXAMPLE,
    '```',
  ]
  if (!skipIndex) {
    lines.push(
      `Step 2: Update \`${ENTRYPOINT_NAME}\` with a single-line pointer under ~150 chars (\`- [Title](file.md) — one-line hook\`) per topic file. Keep \`${ENTRYPOINT_NAME}\` under 200 lines / 25KB with no frontmatter.`,
    )
  }
  return lines.join('\n')
}

/**
 * Builds the background memory-extraction prompt for private auto-memory only.
 */
export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  return [
    buildOpener(newMessageCount, existingMemories),
    '',
    `Memory directory: \`${getAutoMemPath()}\``,
    '',
    TYPES_SECTION_INDIVIDUAL,
    '',
    WHAT_NOT_TO_SAVE_SECTION,
    '',
    buildSaveInstructions(skipIndex),
  ].join('\n')
}

/**
 * Builds the background memory-extraction prompt for combined private + team
 * memory directories.
 */
export function buildExtractCombinedPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  return [
    buildOpener(newMessageCount, existingMemories),
    '',
    `Private memory directory: \`${getAutoMemPath()}\``,
    `Team memory directory: \`${getTeamMemPath()}\``,
    'NEVER save API keys, tokens, passwords, private keys, or personal secrets in team memory.',
    '',
    TYPES_SECTION_COMBINED,
    '',
    WHAT_NOT_TO_SAVE_SECTION,
    '',
    buildSaveInstructions(skipIndex),
  ].join('\n')
}
