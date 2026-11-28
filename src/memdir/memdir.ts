/**
 * Core `memdir` entrypoint truncation (`200` lines / `25KB`), directory setup,
 * and system prompt memory section assembly (`loadMemoryPrompt`,
 * `buildMemoryPrompt`, `buildMemoryLines`).
 */

import { readFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from '../utilities/debug.js'
import { isFeatureEnabled } from '../utilities/feature_flags.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './memory_types.js'
import {
  AUTO_MEM_ENTRYPOINT_NAME,
  getAutoMemPath,
  isAutoMemoryEnabled,
} from './paths.js'
import { getTeamMemPath, isTeamMemoryEnabled } from './team_mem_paths.js'
import { buildCombinedMemoryPrompt } from './team_mem_prompts.js'

export const ENTRYPOINT_NAME = AUTO_MEM_ENTRYPOINT_NAME
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'

export interface EntrypointTruncation {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  return `${(bytes / 1024).toFixed(1)}KB`
}

/**
 * Truncates `MEMORY.md` entrypoint content to at most `200` lines and `25,000`
 * bytes, appending a clear diagnostic warning when either cap triggers.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const lines = trimmed ? trimmed.split('\n') : []
  const lineCount = lines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated: false,
      wasByteTruncated: false,
    }
  }

  let truncated = wasLineTruncated
    ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutNl = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated =
      cutNl > 0
        ? truncated.slice(0, cutNl)
        : truncated.slice(0, MAX_ENTRYPOINT_BYTES)
  }

  let reason: string
  if (wasLineTruncated && wasByteTruncated) {
    reason = `${lineCount} lines and ${formatByteSize(byteCount)}`
  } else if (wasLineTruncated) {
    reason = `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
  } else {
    reason = `${formatByteSize(byteCount)} (limit: ${formatByteSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
  }

  const warning = `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`

  return {
    content: `${truncated}${warning}`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/**
 * Ensures `memoryDir` exists on disk, swallowing non-fatal permission errors.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  try {
    await mkdir(memoryDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    logForDebugging(
      `Failed to ensure memory directory ${memoryDir}: ${String(error)}`,
      { level: 'warn' },
    )
  }
}

/**
 * Optional past-context search section gated on `tengu_coral_fern`.
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  if (!getFeatureValueCachedMayBeStale('tengu_coral_fern', false)) {
    return []
  }
  return [
    '',
    '## Searching past context',
    `- Search topic \`*.md\` files under \`${autoMemDir}\` first with Grep before falling back to project \`*.jsonl\` transcripts.`,
  ]
}

/**
 * Builds the behavioral memory guidance lines for the system prompt.
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string,
  skipIndex = false,
): string[] {
  const lines: string[] = [
    `# ${displayName}`,
    '',
    `Memory directory: \`${memoryDir}\``,
    DIR_EXISTS_GUIDANCE,
    '',
    TYPES_SECTION_INDIVIDUAL,
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
      `Step 2: Add a concise one-line pointer under ~150 chars (\`- [Title](file.md) — one-line hook\`) to \`${ENTRYPOINT_NAME}\` (do not include YAML frontmatter in \`${ENTRYPOINT_NAME}\`).`,
    )
  }

  lines.push(
    '',
    WHEN_TO_ACCESS_SECTION,
    '',
    TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    '- Use memory for durable cross-session facts, preferences, and external pointers.',
    '- Use plans and tasks for active work tracking within a session.',
  )

  if (extraGuidelines?.trim()) {
    lines.push('', extraGuidelines.trim())
  }

  lines.push(...buildSearchingPastContextSection(memoryDir))
  return lines
}

/**
 * Synchronous agent-memory prompt builder embedding truncated `MEMORY.md`
 * contents (used by custom agent definitions with `memory:` enabled).
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string
}): string {
  const lines = buildMemoryLines(
    params.displayName,
    params.memoryDir,
    params.extraGuidelines,
    false,
  )
  const entrypointPath = join(params.memoryDir, ENTRYPOINT_NAME)
  let raw = ''
  try {
    raw = readFileSync(entrypointPath, 'utf8')
  } catch {
    raw = ''
  }

  lines.push('', `## ${ENTRYPOINT_NAME}`)
  if (!raw.trim()) {
    lines.push(`(${ENTRYPOINT_NAME} is currently empty.)`)
  } else {
    lines.push(truncateEntrypointContent(raw).content)
  }
  return lines.join('\n')
}

/**
 * Assembles the main-agent persistent memory system prompt section, or returns
 * `null` when auto-memory is disabled.
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()
  if (!autoEnabled) {
    logEvent('tengu_memdir_disabled', {})
    if (getFeatureValueCachedMayBeStale('tengu_herring_clock', false)) {
      logEvent('tengu_team_memdir_disabled', {})
    }
    return null
  }

  const skipIndex = getFeatureValueCachedMayBeStale('tengu_moth_copse', false)
  const extraGuidelines =
    process.env.COPILOT_CLI_MEMORY_EXTRA_GUIDELINES ??
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES

  if (isFeatureEnabled('TEAMMEM') && isTeamMemoryEnabled()) {
    await ensureMemoryDirExists(getTeamMemPath())
    return buildCombinedMemoryPrompt(extraGuidelines, skipIndex)
  }

  const autoDir = getAutoMemPath()
  await ensureMemoryDirExists(autoDir)
  return buildMemoryLines(
    'auto memory',
    autoDir,
    extraGuidelines,
    skipIndex,
  ).join('\n')
}
