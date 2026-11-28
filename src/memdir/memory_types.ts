/**
 * Four-category persistent memory taxonomy (`user`, `feedback`, `project`,
 * `reference`) and shared prompt guidance sections used by `memdir`,
 * `extract_memories`, and `team_mem_prompts`.
 */

export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const

export type TopicMemoryType = (typeof MEMORY_TYPES)[number]

/**
 * Parses a frontmatter `type:` field into a valid `TopicMemoryType`,
 * returning `undefined` for missing or unrecognized values so legacy memory
 * files degrade gracefully.
 */
export function parseMemoryType(raw: unknown): TopicMemoryType | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const normalized = raw.trim().toLowerCase()
  if ((MEMORY_TYPES as readonly string[]).includes(normalized)) {
    return normalized as TopicMemoryType
  }
  return undefined
}

export const MEMORY_FRONTMATTER_EXAMPLE = `---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{user, feedback, project, reference}}
---

{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}`

export const TYPES_SECTION_INDIVIDUAL = `## Types of memory

There are four discrete types of memory to save:

- **user**: Information about the user's role, goals, responsibilities, domain expertise, and collaboration preferences. Avoid negative judgments or work-irrelevant personal details.
- **feedback**: Guidance the user gave on how to approach work — both corrections ("don't do X", "stop doing Y") and validated confirmations ("yes, keep doing Z"). Structure body with the rule first, followed by \`**Why:**\` and \`**How to apply:**\` lines.
- **project**: Ongoing work, goals, initiatives, bugs, incidents, or deadlines not derivable from code or git history. Always convert relative dates (e.g., "Thursday", "next week") into absolute ISO dates (e.g., "2026-03-05"). Structure body with the fact/decision first, followed by \`**Why:**\` and \`**How to apply:**\` lines.
- **reference**: Pointers to external systems where live information resides (issue trackers, dashboards, runbooks, channels).`

export const TYPES_SECTION_COMBINED = `## Types of memory

There are four discrete types of memory to save, each with scope guidance:

- **user** (<scope>always private</scope>): Information about the user's role, goals, responsibilities, domain expertise, and collaboration preferences.
- **feedback** (<scope>default to private; save as team only when clearly a project-wide convention</scope>): Guidance on how to approach work — both corrections and validated confirmations. Check for contradictions with team feedback before saving private overrides. Lead with the rule, then \`**Why:**\` and \`**How to apply:**\`.
- **project** (<scope>private or team, strongly bias toward team</scope>): Ongoing work, initiatives, incidents, or deadlines not derivable from code or git history. Always convert relative dates to absolute ISO dates. Lead with the fact/decision, then \`**Why:**\` and \`**How to apply:**\`.
- **reference** (<scope>usually team</scope>): Pointers to external systems (issue trackers, dashboards, runbooks, channels).`

export const WHAT_NOT_TO_SAVE_SECTION = `## What NOT to save in memory

- Code patterns, architecture, conventions, file paths, or project structure that can be derived directly by reading the codebase.
- Git history, recent changes, or who-changed-what — \`git log\` and \`git blame\` are authoritative.
- Debugging fix recipes or stack traces — the fix lives in the code and commit message.
- Anything already documented in \`INSTRUCTIONS.md\` or \`.copilot/rules/\`.
- Ephemeral task details, current conversation state, or in-progress plans (use tasks/plans instead).
- Do not save raw PR lists or activity summaries even if requested — ask what was surprising or non-obvious instead.`

export const MEMORY_DRIFT_CAVEAT =
  'Memory records what was true when written, not necessarily live repository state. Before asserting facts from memory, verify against current files and git state, and update or remove stale memories.'

export const WHEN_TO_ACCESS_SECTION = `## When to access memories

- Access memory when relevant to the user's request or when they reference prior work.
- Always consult memory when the user explicitly asks you to remember or recall something.
- If the user asks you to ignore or not use memory for a task, proceed as if \`MEMORY.md\` were empty without citing, comparing, or mentioning memory.
- ${MEMORY_DRIFT_CAVEAT}`

export const TRUSTING_RECALL_SECTION = `## Before recommending from memory

- Verify that any file path named in memory still exists before referencing or editing it.
- Grep for named functions, flags, or symbols before recommending changes to them.
- "The memory says X exists" is not the same as "X exists now."
- Prefer reading live code or running \`git log\` over relying on frozen repository snapshots.`
