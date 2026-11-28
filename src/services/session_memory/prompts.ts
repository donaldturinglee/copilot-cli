/**
 * Ten-section Session Memory `summary.md` template, custom config loaders,
 * size/truncation analyzers, and forked-agent update prompt builder.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utilities/env_utils.js'
import { roughTokenCountEstimation } from '../token_estimation.js'

export const MAX_SECTION_LENGTH = 2_000
export const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`

function getDefaultUpdatePrompt(): string {
  return `Update the session memory markdown file at \`{{notesPath}}\` based on the conversation so far.

Current contents of \`{{notesPath}}\`:
\`\`\`markdown
{{currentNotes}}
\`\`\`

Rules:
- ONLY call the \`Edit\` tool on \`{{notesPath}}\`. Issue all edits in parallel in a single turn if possible.
- Preserve every \`# Header\` line and \`_italic description_\` line verbatim.
- Keep each section concise and under ~${MAX_SECTION_LENGTH} tokens (total file under ~${MAX_TOTAL_SESSION_MEMORY_TOKENS} tokens).
- Keep \`# Current State\` strictly up to date so conversation compaction can resume seamlessly without losing context.
- Never mention note-taking, memory extraction, or this prompt inside the file.
- Leave sections blank rather than adding filler if nothing relevant occurred.
- Do not duplicate static project instructions already documented in \`INSTRUCTIONS.md\`.`
}

/**
 * Loads an optional custom session memory template from
 * `~/.copilot/session-memory/config/template.md`, falling back to the built-in
 * 10-section template.
 */
export async function loadSessionMemoryTemplate(): Promise<string> {
  const customPath = join(
    getClaudeConfigHomeDir(),
    'session-memory',
    'config',
    'template.md',
  )
  try {
    const content = await readFile(customPath, 'utf8')
    if (content.trim().length > 0) {
      return content
    }
  } catch {
    // Fall back to built-in template
  }
  return DEFAULT_SESSION_MEMORY_TEMPLATE
}

/**
 * Loads an optional custom update prompt from
 * `~/.copilot/session-memory/config/prompt.md`, falling back to default.
 */
export async function loadSessionMemoryPrompt(): Promise<string> {
  const customPath = join(
    getClaudeConfigHomeDir(),
    'session-memory',
    'config',
    'prompt.md',
  )
  try {
    const content = await readFile(customPath, 'utf8')
    if (content.trim().length > 0) {
      return content
    }
  } catch {
    // Fall back to default update prompt
  }
  return getDefaultUpdatePrompt()
}

export interface SectionSizeInfo {
  header: string
  tokens: number
}

/**
 * Estimates token count per top-level `# ` section in `content`.
 */
export function analyzeSectionSizes(content: string): {
  totalTokens: number
  sections: SectionSizeInfo[]
  oversizedSections: SectionSizeInfo[]
} {
  const lines = content.split(/\r?\n/)
  const sections: SectionSizeInfo[] = []
  let currentHeader = '(preamble)'
  let currentLines: string[] = []

  const flush = (): void => {
    const text = currentLines.join('\n')
    if (currentHeader !== '(preamble)' || text.trim().length > 0) {
      sections.push({
        header: currentHeader,
        tokens: roughTokenCountEstimation(text),
      })
    }
  }

  for (const line of lines) {
    if (line.startsWith('# ')) {
      flush()
      currentHeader = line.trim()
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flush()

  const totalTokens = roughTokenCountEstimation(content)
  const oversizedSections = sections
    .filter(s => s.tokens > MAX_SECTION_LENGTH)
    .sort((a, b) => b.tokens - a.tokens)

  return { totalTokens, sections, oversizedSections }
}

/**
 * Generates tightening reminders when total size exceeds `12k` tokens or any
 * individual section exceeds `2k` tokens.
 */
export function generateSectionReminders(content: string): string {
  const { totalTokens, oversizedSections } = analyzeSectionSizes(content)
  const parts: string[] = []
  if (totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS) {
    parts.push(
      `CRITICAL: Total session memory is ~${totalTokens} tokens (limit: ${MAX_TOTAL_SESSION_MEMORY_TOKENS}). Aggressively condense older worklog and resolved items.`,
    )
  }
  if (oversizedSections.length > 0) {
    const list = oversizedSections
      .map(s => `- ${s.header}: ~${s.tokens} tokens (limit: ${MAX_SECTION_LENGTH})`)
      .join('\n')
    parts.push(`The following sections exceed ${MAX_SECTION_LENGTH} tokens and must be condensed:\n${list}`)
  }
  return parts.join('\n\n')
}

/**
 * Builds the session-memory update prompt with single-pass token substitution
 * (preventing `$` backreference corruption or double-substitution) plus any
 * section-size reminders.
 */
export async function buildSessionMemoryUpdatePrompt(
  currentNotes: string,
  notesPath: string,
): Promise<string> {
  const template = await loadSessionMemoryPrompt()
  const rendered = template.replace(
    /\{\{(currentNotes|notesPath)\}\}/g,
    (_match, key: string) =>
      key === 'currentNotes' ? currentNotes : notesPath,
  )
  const reminders = generateSectionReminders(currentNotes)
  return reminders ? `${rendered}\n\n${reminders}` : rendered
}

/**
 * Returns `true` if `content` is still identical to the blank template.
 */
export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return true
  }
  const template = await loadSessionMemoryTemplate()
  return trimmed === template.trim()
}

/**
 * Truncates any `# ` section exceeding `MAX_SECTION_LENGTH * 4` (`8,000` chars)
 * at a newline boundary before injecting session memory during compaction.
 */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string
  wasTruncated: boolean
} {
  const maxSectionChars = MAX_SECTION_LENGTH * 4
  const lines = content.split(/\r?\n/)
  const outputSections: string[] = []
  let currentLines: string[] = []
  let wasTruncated = false

  const flushSection = (): void => {
    if (currentLines.length === 0) {
      return
    }
    const rawSection = currentLines.join('\n')
    if (rawSection.length <= maxSectionChars) {
      outputSections.push(rawSection)
      return
    }
    wasTruncated = true
    const slice = rawSection.slice(0, maxSectionChars)
    const lastNewline = slice.lastIndexOf('\n')
    const cut = lastNewline > 0 ? slice.slice(0, lastNewline) : slice
    outputSections.push(`${cut}\n[... section truncated for length ...]`)
  }

  for (const line of lines) {
    if (line.startsWith('# ') && currentLines.length > 0) {
      flushSection()
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flushSection()

  return {
    truncatedContent: outputSections.join('\n'),
    wasTruncated,
  }
}
