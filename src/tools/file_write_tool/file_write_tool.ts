/**
 * `FileWriteTool` (`Write`):
 * - Creates new files (auto-creating parent directories) or overwrites existing
 *   files after enforcing read-before-overwrite and mtime staleness checks.
 * - Preserves existing encoding and line endings when updating existing files.
 * - Updates `context.readFileState` and computes structured diff hunks.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import { dirname } from 'path'
import { z } from 'zod/v4'
import { addToTotalLinesChanged } from '../../bootstrap/state.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { FILE_WRITE_TOOL_NAME } from '../../constants/tools.js'
import { isTeamMemPath } from '../../memdir/team_mem_paths.js'
import { checkTeamMemSecrets } from '../../services/team_memory_sync/team_mem_secret_guard.js'
import { notifyTeamMemoryWrite } from '../../services/team_memory_sync/watcher.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { randomUUID } from '../../utilities/crypto.js'
import {
  countLinesChanged,
  getPatchFromContents,
  type StructuredPatchHunk,
} from '../../utilities/diff.js'
import { isEnoent } from '../../utilities/errors.js'
import {
  detectFileEncoding,
  detectLineEndings,
  getFileModificationTime,
  writeTextContent,
} from '../../utilities/file.js'
import { fileHistoryTrackEdit } from '../../utilities/file_history.js'
import { logFileOperation } from '../../utilities/file_operation_analytics.js'
import { getFsImplementation } from '../../utilities/fs_operations.js'
import { expandPath } from '../../utilities/path.js'
import { checkWritePermissionForTool } from '../../utilities/permissions/rule_matching.js'
import { validateInputForSettingsFileEdit } from '../file_edit_tool/utils.js'
import {
  FILE_WRITE_TOOL_DESCRIPTION,
  FILE_WRITE_TOOL_PROMPT,
} from './prompt.js'

const FileWriteInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to write'),
  content: z.string().describe('The content to write to the file'),
})

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>

export interface FileWriteOutput {
  type: 'create' | 'update'
  filePath: string
  content: string
  structuredPatch: StructuredPatchHunk[]
  originalFile: string | null
}

function normalizeCrLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export const FileWriteTool = buildTool<FileWriteInput, FileWriteOutput>({
  name: FILE_WRITE_TOOL_NAME,
  aliases: ['FileWrite'],
  searchHint: 'create or overwrite a file with full contents',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  inputSchema: FileWriteInputSchema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  interruptBehavior: () => 'block',

  getPath(input) {
    return input.file_path
  },

  backfillObservableInput(input) {
    if (typeof input.file_path === 'string' && input.file_path.trim()) {
      input.file_path = expandPath(input.file_path)
    }
  },

  toAutoClassifierInput(input) {
    return `Write ${input.file_path} (${input.content.length} chars)`
  },

  userFacingName(input) {
    return input?.file_path ? `Write(${input.file_path})` : FILE_WRITE_TOOL_NAME
  },

  async description() {
    return FILE_WRITE_TOOL_DESCRIPTION
  },

  async prompt() {
    return FILE_WRITE_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    return checkWritePermissionForTool(
      { name: FILE_WRITE_TOOL_NAME, aliases: ['FileWrite'] },
      input,
      input.file_path,
      permCtx,
    )
  },

  async validateInput(input, context) {
    if (!input.file_path.trim()) {
      return {
        result: false,
        message: 'file_path must be a non-empty path.',
        errorCode: 1,
      }
    }

    const fullPath = expandPath(input.file_path)
    const secretError = checkTeamMemSecrets(fullPath, input.content)
    if (secretError) {
      return {
        result: false,
        message: secretError,
        errorCode: 2,
      }
    }
    const settingsCheck = validateInputForSettingsFileEdit(
      fullPath,
      input.content,
    )
    if (!settingsCheck.valid) {
      return {
        result: false,
        message: settingsCheck.message,
        errorCode: 2,
      }
    }

    const fsImpl = getFsImplementation()
    let stats
    try {
      stats = fsImpl.statSync(fullPath)
    } catch (error) {
      if (isEnoent(error)) {
        return { result: true }
      }
      return {
        result: false,
        message: `Unable to stat ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 3,
      }
    }

    if (stats.isDirectory()) {
      return {
        result: false,
        message: `Cannot write to ${fullPath}: path is a directory.`,
        errorCode: 4,
      }
    }

    const readState = context.readFileState?.get(fullPath)
    if (!readState) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before overwriting it.',
        errorCode: 5,
      }
    }

    const currentMtime = Math.floor(stats.mtimeMs)
    if (currentMtime > readState.timestamp) {
      const encoding = detectFileEncoding(fullPath)
      const rawDisk = fsImpl.readFileSync(fullPath, { encoding })
      const normalizedDisk = normalizeCrLf(
        rawDisk.charCodeAt(0) === 0xfeff ? rawDisk.slice(1) : rawDisk,
      )
      const isFullReadMatch =
        !readState.isPartialView &&
        readState.offset === undefined &&
        readState.limit === undefined &&
        normalizeCrLf(readState.content) === normalizedDisk
      if (!isFullReadMatch) {
        return {
          result: false,
          message:
            'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
          errorCode: 6,
        }
      }
    }

    return { result: true }
  },

  async call(input, context: ToolUseContext, _canUseTool, parentMessage) {
    const fullPath = expandPath(input.file_path)
    const fsImpl = getFsImplementation()
    const exists = fsImpl.existsSync(fullPath)

    const encoding: BufferEncoding = exists
      ? detectFileEncoding(fullPath)
      : 'utf8'
    const endings = exists ? detectLineEndings(fullPath, encoding) : 'LF'
    const originalFile = exists
      ? normalizeCrLf(fsImpl.readFileSync(fullPath, { encoding }))
      : null

    if (context.updateFileHistoryState) {
      const parentUuid =
        parentMessage &&
        typeof parentMessage === 'object' &&
        'uuid' in parentMessage &&
        typeof (parentMessage as { uuid?: unknown }).uuid === 'string'
          ? (parentMessage as { uuid: string }).uuid
          : undefined
      await fileHistoryTrackEdit(
        context.updateFileHistoryState,
        fullPath,
        (parentUuid ?? randomUUID()) as UUID,
      )
    }

    fsImpl.mkdirSync(dirname(fullPath))
    writeTextContent(fullPath, input.content, encoding, endings)

    if (isTeamMemPath(fullPath)) {
      notifyTeamMemoryWrite()
    }

    const newMtime = getFileModificationTime(fullPath)
    const normalizedContent = normalizeCrLf(input.content)
    context.readFileState?.set(fullPath, {
      content: normalizedContent,
      timestamp: newMtime,
      isPartialView: false,
    })

    const structuredPatch = getPatchFromContents({
      filePath: fullPath,
      oldContent: originalFile ?? '',
      newContent: normalizedContent,
    })
    const { added, removed } = countLinesChanged(structuredPatch)
    addToTotalLinesChanged(added, removed)

    logFileOperation({
      operation: 'write',
      tool: FILE_WRITE_TOOL_NAME,
      filePath: fullPath,
      content: normalizedContent,
      linesAdded: added,
      linesRemoved: removed,
      success: true,
    })

    return {
      data: {
        type: exists ? 'update' : 'create',
        filePath: fullPath,
        content: normalizedContent,
        structuredPatch,
        originalFile,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    const verb = output.type === 'create' ? 'created' : 'updated'
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `File ${verb} successfully at: ${output.filePath}`,
    }
  },
})
