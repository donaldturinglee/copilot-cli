/**
 * Constants for `NotebookEditTool` (`NotebookEdit`).
 */

export const NOTEBOOK_EDIT_MODES = ['replace', 'insert', 'delete'] as const
export type NotebookEditMode = (typeof NOTEBOOK_EDIT_MODES)[number]
