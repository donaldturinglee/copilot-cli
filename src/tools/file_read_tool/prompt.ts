/**
 * Model-facing description and prompt text for `FileReadTool` (`Read`).
 */

export const FILE_READ_TOOL_DESCRIPTION =
  'Reads a file from the local filesystem (text with line numbers, images, PDFs with page ranges, or Jupyter notebooks).'

export const FILE_READ_TOOL_PROMPT = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Usage:
- The file_path parameter must be an absolute path, not a relative path.
- By default, it reads up to 2000 lines starting from the beginning of the file.
- You can optionally specify a line offset and limit (especially handy for long files).
- Results are returned with 1-based line numbers.
- Supports images (PNG, JPEG, GIF, WebP), PDFs (use \`pages\` like "1-5" for large PDFs, max 20 pages per request), and Jupyter notebooks (.ipynb).
- Call Read in parallel whenever you need to inspect multiple independent files.`
