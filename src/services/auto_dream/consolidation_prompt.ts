/**
 * Four-phase consolidation prompt (`Orient`, `Gather`, `Consolidate`, `Prune & Index`)
 * for background `autoDream` memory maintenance.
 */

export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'

/**
 * Builds the 4-phase memory consolidation prompt for `autoDream`.
 */
export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra = '',
): string {
  const sections = [
    '# Dream: Memory Consolidation',
    '',
    `Memory directory: \`${memoryRoot}\``,
    DIR_EXISTS_GUIDANCE,
    `Transcript directory: \`${transcriptDir}\` (grep narrowly for specific signals; never read entire JSONL transcripts).`,
    '',
    '## Phase 1 — Orient',
    '- List the memory directory, read `MEMORY.md`, and skim existing topic files.',
    '- Inspect `logs/` or `sessions/` subdirectories if present.',
    '',
    '## Phase 2 — Gather recent signal',
    'Prioritize signal in this order:',
    '1. Daily logs (`logs/YYYY/MM/YYYY-MM-DD.md`) if present.',
    '2. Existing memories that may have drifted relative to the current codebase.',
    `3. Narrow transcript searches (e.g. \`grep -rn "<narrow term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\`). Do not exhaustively read transcripts.`,
    '',
    '## Phase 3 — Consolidate',
    '- Write or update top-level topic files using the 4-type frontmatter taxonomy (`user`, `feedback`, `project`, `reference`).',
    '- Merge related updates into existing topic files instead of creating duplicates.',
    '- Convert relative dates into absolute ISO dates (`YYYY-MM-DD`).',
    '- Delete or correct contradicted facts directly at their source.',
    '',
    '## Phase 4 — Prune and index',
    '- Update `MEMORY.md` to stay strictly under 200 lines AND under 25KB.',
    '- Keep every index entry to a single line under ~150 characters: `- [Title](file.md) — one-line hook`.',
    '- Remove stale, wrong, or superseded pointers; demote verbose entries (>200 chars) into topic files; add pointers to new memories; resolve contradictions.',
    '',
    'Return a brief summary of what was consolidated, updated, or pruned.',
  ]

  if (extra.trim().length > 0) {
    sections.push('', '## Additional context', '', extra.trim())
  }

  return sections.join('\n')
}
