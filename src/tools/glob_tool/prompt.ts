/**
 * Model-facing description and prompt text for `GlobTool` (`Glob`).
 */

export const GLOB_TOOL_DESCRIPTION =
  'Fast file pattern matching tool that finds files by glob pattern sorted by modification time.'

export const GLOB_TOOL_PROMPT = `Fast file pattern matching tool that works with any codebase size.
- Supports glob patterns like "**/*.js" or "src/**/*.ts".
- Returns matching file paths sorted by modification time (up to 100 results by default).
- Use this tool when you need to find files by name patterns.`
