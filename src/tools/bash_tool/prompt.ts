/**
 * Model-facing description and prompt text for `BashTool` (`Bash`).
 */

export const BASH_TOOL_DESCRIPTION =
  'Executes a bash command in a persistent working directory with optional timeout and background execution.'

export const BASH_TOOL_PROMPT = `Executes a given bash command and returns its output.
Usage:
- Working directory persists across commands; shell variables/aliases do not persist unless exported via CLAUDE_ENV_FILE.
- Prefer dedicated tools (Read, Edit, Write, Glob, Grep) over shell commands for file operations.
- Default timeout is 120000ms (max 600000ms).
- Set \`run_in_background: true\` for long-running processes such as dev servers or watchers.`
