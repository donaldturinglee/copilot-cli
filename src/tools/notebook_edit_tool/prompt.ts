/**
 * Model-facing description and prompt text for `NotebookEditTool` (`NotebookEdit`).
 */

export const NOTEBOOK_EDIT_TOOL_DESCRIPTION =
  'Replaces, inserts, or deletes a specific cell in a Jupyter notebook (.ipynb).'

export const NOTEBOOK_EDIT_TOOL_PROMPT = `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source, or inserts/deletes cells.
Usage:
- \`notebook_path\` must be an absolute path to a .ipynb file.
- \`cell_id\` identifies the target cell by its cell ID or synthetic \`cell-N\` 0-based index.
- \`edit_mode\` can be "replace" (default), "insert" (adds a new cell after cell_id, or at the start if omitted), or "delete".
- For "insert", \`cell_type\` ("code" or "markdown") is required.`
