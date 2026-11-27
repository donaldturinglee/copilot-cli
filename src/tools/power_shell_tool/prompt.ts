/**
 * Model-facing description and prompt text for `PowerShellTool` (`PowerShell`).
 */

export const POWERSHELL_TOOL_DESCRIPTION =
  'Executes a PowerShell command in a persistent working directory with optional timeout and background execution.'

export const POWERSHELL_TOOL_PROMPT = `Executes a given PowerShell command and returns its output.
Usage:
- Working directory persists across commands via Get-Location capture.
- Prefer dedicated tools (Read, Edit, Write, Glob, Grep) for file inspection and editing.
- Default timeout is 120000ms (max 600000ms).
- Set \`run_in_background: true\` for long-running processes.`
