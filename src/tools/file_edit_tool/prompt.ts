/**
 * Model-facing description and prompt text for `FileEditTool` (`Edit`).
 */

export const FILE_EDIT_TOOL_DESCRIPTION =
  'Performs exact string replacements in files.'

export const FILE_EDIT_TOOL_PROMPT = `Performs exact string replacements in files.
Usage:
- You must use the Read tool at least once in the conversation before editing an existing file.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- For Jupyter notebooks (.ipynb), use NotebookEdit instead of Edit.
- Preserve exact indentation and whitespace from the file.`
