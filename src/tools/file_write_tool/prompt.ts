/**
 * Model-facing description and prompt text for `FileWriteTool` (`Write`).
 */

export const FILE_WRITE_TOOL_DESCRIPTION =
  'Writes a file to the local filesystem, creating parent directories if needed.'

export const FILE_WRITE_TOOL_PROMPT = `Writes a file to the local filesystem.
Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents.
- Prefer the Edit tool for modifying existing files instead of rewriting the whole file.`
