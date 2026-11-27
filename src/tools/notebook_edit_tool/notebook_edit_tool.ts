/**
 * `NotebookEditTool` (`NotebookEdit`):
 * - Deferred tool (`shouldDefer: true`) for replacing, inserting, or deleting
 *   Jupyter `.ipynb` cells by cell ID or `cell-N` index.
 * - Enforces `.ipynb` extension, read-before-edit, and mtime staleness checks.
 * - Generates cell IDs for nbformat >= 4.5 and resets code cell outputs /
 *   execution counts on replacement.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomBytes } from 'crypto'
import { extname } from 'path'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../constants/tools.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookContent,
} from '../../types/notebook.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { isEnoent } from '../../utilities/errors.js'
import {
  detectFileEncoding,
  detectLineEndings,
  getFileModificationTime,
  writeTextContent,
} from '../../utilities/file.js'
import { logFileOperation } from '../../utilities/file_operation_analytics.js'
import { getFsImplementation } from '../../utilities/fs_operations.js'
import { parseCellId } from '../../utilities/notebook.js'
import { expandPath } from '../../utilities/path.js'
import { checkWritePermissionForTool } from '../../utilities/permissions/rule_matching.js'
import { NOTEBOOK_EDIT_MODES, type NotebookEditMode } from './constants.js'
import {
  NOTEBOOK_EDIT_TOOL_DESCRIPTION,
  NOTEBOOK_EDIT_TOOL_PROMPT,
} from './prompt.js'

const NotebookEditInputSchema = z.object({
  notebook_path: z
    .string()
    .describe('The absolute path to the Jupyter notebook file (.ipynb)'),
  cell_id: z
    .string()
    .optional()
    .describe('The ID of the cell to edit (or synthetic cell-N 0-based index)'),
  new_source: z.string().describe('The new source for the cell'),
  cell_type: z
    .enum(['code', 'markdown'])
    .optional()
    .describe('The type of the cell (code or markdown)'),
  edit_mode: z
    .enum(NOTEBOOK_EDIT_MODES)
    .optional()
    .default('replace')
    .describe('The type of edit to make (replace, insert, delete)'),
})

export type NotebookEditInput = z.infer<typeof NotebookEditInputSchema>

export interface NotebookEditOutput {
  new_source: string
  cell_id?: string
  cell_type: NotebookCellType
  language: string
  edit_mode: NotebookEditMode
  error?: string
  notebook_path: string
}

function findCellIndex(
  cells: readonly NotebookCell[],
  cellId: string,
): number {
  const exactIdx = cells.findIndex(c => c.id === cellId)
  if (exactIdx !== -1) {
    return exactIdx
  }
  const parsedIdx = parseCellId(cellId)
  if (parsedIdx !== undefined && parsedIdx >= 0 && parsedIdx < cells.length) {
    return parsedIdx
  }
  return -1
}

function generateCellId(): string {
  return randomBytes(4).toString('hex')
}

function supportsCellIds(notebook: NotebookContent): boolean {
  return (
    notebook.nbformat > 4 ||
    (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
  )
}

export const NotebookEditTool = buildTool<
  NotebookEditInput,
  NotebookEditOutput
>({
  name: NOTEBOOK_EDIT_TOOL_NAME,
  searchHint: 'edit, insert, or delete Jupyter notebook (.ipynb) cells',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: NotebookEditInputSchema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  interruptBehavior: () => 'block',

  getPath(input) {
    return input.notebook_path
  },

  backfillObservableInput(input) {
    if (typeof input.notebook_path === 'string' && input.notebook_path.trim()) {
      input.notebook_path = expandPath(input.notebook_path)
    }
  },

  toAutoClassifierInput(input) {
    return `NotebookEdit ${input.notebook_path} (${input.edit_mode ?? 'replace'})`
  },

  userFacingName(input) {
    return input?.notebook_path
      ? `NotebookEdit(${input.notebook_path})`
      : NOTEBOOK_EDIT_TOOL_NAME
  },

  async description() {
    return NOTEBOOK_EDIT_TOOL_DESCRIPTION
  },

  async prompt() {
    return NOTEBOOK_EDIT_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    return checkWritePermissionForTool(
      { name: NOTEBOOK_EDIT_TOOL_NAME },
      input,
      input.notebook_path,
      permCtx,
    )
  },

  async validateInput(input, context) {
    const fullPath = expandPath(input.notebook_path)
    if (extname(fullPath).toLowerCase() !== '.ipynb') {
      return {
        result: false,
        message:
          'File must be a Jupyter notebook (.ipynb file). For other file types, use the Edit tool.',
        errorCode: 1,
      }
    }

    const editMode = input.edit_mode ?? 'replace'
    if (editMode === 'insert' && !input.cell_type) {
      return {
        result: false,
        message: 'cell_type is required when edit_mode is "insert".',
        errorCode: 2,
      }
    }

    const fsImpl = getFsImplementation()
    let stats
    try {
      stats = fsImpl.statSync(fullPath)
    } catch (error) {
      if (isEnoent(error)) {
        return {
          result: false,
          message: `Notebook file does not exist: ${fullPath}`,
          errorCode: 3,
        }
      }
      return {
        result: false,
        message: `Cannot access notebook ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 3,
      }
    }

    const readState = context.readFileState?.get(fullPath)
    if (!readState) {
      return {
        result: false,
        message:
          'Notebook has not been read yet. Read it with the Read tool first before editing it.',
        errorCode: 4,
      }
    }

    const currentMtime = Math.floor(stats.mtimeMs)
    const encoding = detectFileEncoding(fullPath)
    const raw = fsImpl.readFileSync(fullPath, { encoding })
    if (currentMtime > readState.timestamp && raw !== readState.content) {
      return {
        result: false,
        message:
          'Notebook has been modified since read. Read it again before editing.',
        errorCode: 5,
      }
    }

    let notebook: NotebookContent
    try {
      notebook = JSON.parse(raw) as NotebookContent
    } catch (error) {
      return {
        result: false,
        message: `Notebook is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 6,
      }
    }

    if (!Array.isArray(notebook.cells)) {
      return {
        result: false,
        message: 'Notebook JSON is missing a valid `cells` array.',
        errorCode: 6,
      }
    }

    if (editMode !== 'insert') {
      if (!input.cell_id) {
        return {
          result: false,
          message: `cell_id is required when edit_mode is "${editMode}".`,
          errorCode: 7,
        }
      }
      if (findCellIndex(notebook.cells, input.cell_id) === -1) {
        return {
          result: false,
          message: `Cell with ID "${input.cell_id}" not found in notebook.`,
          errorCode: 8,
        }
      }
    } else if (
      input.cell_id &&
      findCellIndex(notebook.cells, input.cell_id) === -1
    ) {
      return {
        result: false,
        message: `Target cell_id "${input.cell_id}" for insertion not found in notebook.`,
        errorCode: 8,
      }
    }

    return { result: true }
  },

  async call(input, context: ToolUseContext) {
    const fullPath = expandPath(input.notebook_path)
    const fsImpl = getFsImplementation()
    const encoding = detectFileEncoding(fullPath)
    const endings = detectLineEndings(fullPath, encoding)
    const raw = fsImpl.readFileSync(fullPath, { encoding })
    const notebook = JSON.parse(raw) as NotebookContent
    const language = notebook.metadata?.language_info?.name ?? 'python'
    const editMode: NotebookEditMode = input.edit_mode ?? 'replace'

    let resultingCellId = input.cell_id
    let resultingCellType: NotebookCellType = input.cell_type ?? 'code'

    if (editMode === 'insert') {
      const newCellType: NotebookCellType = input.cell_type ?? 'code'
      const newId = supportsCellIds(notebook) ? generateCellId() : undefined
      const newCell: NotebookCell =
        newCellType === 'code'
          ? {
              cell_type: 'code',
              ...(newId ? { id: newId } : {}),
              source: input.new_source,
              metadata: {},
              execution_count: null,
              outputs: [],
            }
          : {
              cell_type: 'markdown',
              ...(newId ? { id: newId } : {}),
              source: input.new_source,
              metadata: {},
            }

      const insertAt = input.cell_id
        ? findCellIndex(notebook.cells, input.cell_id) + 1
        : 0
      notebook.cells.splice(insertAt, 0, newCell)
      resultingCellId = newId ?? `cell-${insertAt}`
      resultingCellType = newCellType
    } else if (editMode === 'delete') {
      const idx = findCellIndex(notebook.cells, input.cell_id!)
      const removed = notebook.cells.splice(idx, 1)[0]
      resultingCellType = removed?.cell_type ?? 'code'
    } else {
      const idx = findCellIndex(notebook.cells, input.cell_id!)
      const target = notebook.cells[idx]!
      const nextType: NotebookCellType = input.cell_type ?? target.cell_type
      target.cell_type = nextType
      target.source = input.new_source
      if (nextType === 'code') {
        target.outputs = []
        target.execution_count = null
      } else {
        delete target.outputs
        delete target.execution_count
      }
      resultingCellId = target.id ?? `cell-${idx}`
      resultingCellType = nextType
    }

    const updatedJson = JSON.stringify(notebook, null, 1) + '\n'
    writeTextContent(fullPath, updatedJson, encoding, endings)

    const newMtime = getFileModificationTime(fullPath)
    context.readFileState?.set(fullPath, {
      content: updatedJson,
      timestamp: newMtime,
      isPartialView: false,
    })

    logFileOperation({
      operation: 'notebook_edit',
      tool: NOTEBOOK_EDIT_TOOL_NAME,
      filePath: fullPath,
      content: updatedJson,
      success: true,
    })

    return {
      data: {
        new_source: input.new_source,
        ...(resultingCellId ? { cell_id: resultingCellId } : {}),
        cell_type: resultingCellType,
        language,
        edit_mode: editMode,
        notebook_path: fullPath,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    if (output.error) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output.error,
        is_error: true,
      }
    }
    const label = output.cell_id ? `cell ${output.cell_id}` : 'cell'
    const action =
      output.edit_mode === 'insert'
        ? `Inserted ${output.cell_type} ${label}`
        : output.edit_mode === 'delete'
          ? `Deleted ${label}`
          : `Updated ${output.cell_type} ${label}`
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `${action} in ${output.notebook_path}.`,
    }
  },
})
