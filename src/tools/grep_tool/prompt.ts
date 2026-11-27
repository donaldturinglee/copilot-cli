/**
 * Model-facing description and prompt text for `GrepTool` (`Grep`).
 */

export const GREP_TOOL_DESCRIPTION =
  'A powerful regex content search tool built on ripgrep supporting content, files_with_matches, and count modes.'

export const GREP_TOOL_PROMPT = `A powerful search tool built on ripgrep.
Usage:
- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").
- Filter files with \`glob\` (e.g. "*.js", "**/*.tsx") or \`type\` (e.g. "ts", "py", "rust").
- Output modes: "files_with_matches" (default, shows matching file paths), "content" (shows matching lines), "count" (shows match counts per file).
- Use \`head_limit\` (default 250; set 0 for unlimited) and \`offset\` to paginate large result sets.
- Enable \`multiline: true\` for patterns spanning multiple lines.`
