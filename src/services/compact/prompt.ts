/**
 * Nine-section compaction prompt templates (full, partial `'from'`, partial
 * `'up_to'`), XML `<analysis>`/`<summary>` formatter, and post-compaction
 * continuation message builder.
 */

import type { PartialCompactDirection } from '../../types/message.js'

export const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

export const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.'

const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts chronologically and verify technical accuracy:
1. Review every user message and request in chronological order.
2. Note the engineering approach, key architectural decisions, and patterns established.
3. Capture exact file paths, function/type signatures, important code snippets, and edits made.
4. Record every error encountered, root cause, and how it was fixed, plus any user corrections.
5. Verify pending tasks and the exact stopping point.`

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags focusing ONLY on the recent messages being summarized (earlier retained context remains visible):
1. Review the recent user requests, edits, tool outputs, and decisions chronologically.
2. Capture exact file paths, code changes, errors, fixes, and user feedback from this recent segment.
3. Identify remaining pending work and exact next steps.`

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary must be enclosed in <summary> tags and include the following 9 sections:
1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created, including exact file paths and relevant snippets or signatures.
4. Errors and fixes: List all errors encountered and how they were resolved, paying special attention to specific user feedback.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results so user intent and feedback remain intact.
7. Pending Tasks: Outline any pending tasks you were explicitly asked to work on.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step directly related to the most recent work, citing direct verbatim quotes from the most recent conversation showing the exact task and stopping point. Do not start tangential or already-completed requests without confirming with the user.

If the conversation or instructions include a \`## Compact Instructions\` or \`# Summary instructions\` section, follow those instructions carefully.

<example>
<analysis>
Chronological review of requests, code changes, test runs, and remaining tasks...
</analysis>
<summary>
1. Primary Request and Intent:
   ...
2. Key Technical Concepts:
   ...
3. Files and Code Sections:
   ...
4. Errors and fixes:
   ...
5. Problem Solving:
   ...
6. All user messages:
   ...
7. Pending Tasks:
   ...
8. Current Work:
   ...
9. Optional Next Step:
   ...
</summary>
</example>`

const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of ONLY the recent portion of the conversation that will be compacted, while earlier retained messages remain in context.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary must be enclosed in <summary> tags and include these 9 sections scoped to the recent messages:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Current Work
9. Optional Next Step (with verbatim quotes of the exact stopping point)`

const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of the earlier portion of the conversation that will be replaced while more recent messages are preserved verbatim immediately after this summary.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary must be enclosed in <summary> tags and include these 9 sections:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Work Completed
9. Context for Continuing Work`

function appendCustomInstructions(
  base: string,
  customInstructions?: string,
): string {
  const trimmed = customInstructions?.trim()
  const body = trimmed
    ? `${base}\n\nAdditional Instructions:\n${trimmed}`
    : base
  return `${NO_TOOLS_PREAMBLE}${body}${NO_TOOLS_TRAILER}`
}

/**
 * Returns the full 9-section compaction prompt with no-tools guardrails and
 * optional custom focus instructions.
 */
export function getCompactPrompt(customInstructions?: string): string {
  return appendCustomInstructions(BASE_COMPACT_PROMPT, customInstructions)
}

/**
 * Returns the partial compaction prompt for either `'from'` (summarize tail)
 * or `'up_to'` (summarize prefix before preserved recent messages).
 */
export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
): string {
  const base =
    direction === 'up_to'
      ? PARTIAL_COMPACT_UP_TO_PROMPT
      : PARTIAL_COMPACT_PROMPT
  return appendCustomInstructions(base, customInstructions)
}

/**
 * Strips the `<analysis>` scratchpad block, unwraps `<summary>...</summary>`
 * into `Summary:\n...`, and collapses excess blank lines.
 */
export function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  formatted = formatted.replace(
    /<summary>([\s\S]*?)<\/summary>/,
    (_match, inner: string) => `Summary:\n${inner.trim()}`,
  )
  return formatted.replace(/\n\n+/g, '\n\n').trim()
}

/**
 * Builds the user-role continuation summary message injected after a
 * `compact_boundary` marker.
 */
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions = false,
  transcriptPath?: string,
  recentMessagesPreserved = false,
): string {
  const formattedSummary = formatCompactSummary(summary)
  let text =
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n' +
    formattedSummary

  if (transcriptPath) {
    text += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    text += '\n\nRecent messages are preserved verbatim.'
  }

  if (suppressFollowUpQuestions) {
    text +=
      '\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.'
  }

  return text
}
