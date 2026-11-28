/**
 * `FileEditTool` (`Edit`):
 * - Strict read-before-edit enforcement (rejects unread or partial-view files).
 * - External modification (mtime) staleness check with full-read content
 *   equality fallback for Windows touch/AV mtime bumps.
 * - `.ipynb` redirect guard -> `NotebookEdit`.
 * - Curly-quote normalization & preservation, `replace_all`, settings JSON
 *   schema validation, atomic write, and `readFileState` update.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import { dirname, extname } from 'path'
import { z } from 'zod/v4'
import { addToTotalLinesChanged } from '../../bootstrap/state.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { FILE_EDIT_TOOL_NAME } from '../../constants/tools.js'
import { isTeamMemPath } from '../../memdir/team_mem_paths.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/lsp_diagnostic_registry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { checkTeamMemSecrets } from '../../services/team_memory_sync/team_mem_secret_guard.js'
import { notifyTeamMemoryWrite } from '../../services/team_memory_sync/watcher.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/load_skills_dir.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { randomUUID } from '../../utilities/crypto.js'
import { getCwd } from '../../utilities/cwd.js'
import {
  countLinesChanged,
  getPatchFromContents,
} from '../../utilities/diff.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import { isEnoent } from '../../utilities/errors.js'
import {
  detectFileEncoding,
  detectLineEndings,
  findSimilarFile,
  getFileModificationTime,
  writeTextContent,
} from '../../utilities/file.js'
import { fileHistoryTrackEdit } from '../../utilities/file_history.js'
import { logFileOperation } from '../../utilities/file_operation_analytics.js'
import { getFsImplementation } from '../../utilities/fs_operations.js'
import { expandPath } from '../../utilities/path.js'
import { checkWritePermissionForTool } from '../../utilities/permissions/rule_matching.js'
import { FILE_EDIT_ERROR_CODES } from './constants.js'
import { FILE_EDIT_TOOL_DESCRIPTION, FILE_EDIT_TOOL_PROMPT } from './prompt.js'
import type { FileEditOutput } from './types.js'
import {
  applyStringEdit,
  countOccurrences,
  findActualString,
  preserveQuoteStyle,
  validateInputForSettingsFileEdit,
} from './utils.js'

const FileEditInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to modify'),
  old_string: z.string().describe('The text to replace'),
  new_string: z.string().describe('The text to replace it with'),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe('Replace all occurrences of old_string (default false)'),
})

export type FileEditInput = z.infer<typeof FileEditInputSchema>

function normalizeCrLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export const FileEditTool = buildTool<FileEditInput, FileEditOutput>({
  name: FILE_EDIT_TOOL_NAME,
  aliases: ['FileEdit'],
  searchHint: 'make targeted string replacements in a file',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  inputSchema: FileEditInputSchema,

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
    return `${input.file_path}: replace ${input.old_string.length} chars with ${input.new_string.length} chars`
  },

  userFacingName(input) {
    return input?.file_path ? `Edit(${input.file_path})` : FILE_EDIT_TOOL_NAME
  },

  async description() {
    return FILE_EDIT_TOOL_DESCRIPTION
  },

  async prompt() {
    return FILE_EDIT_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    return checkWritePermissionForTool(
      { name: FILE_EDIT_TOOL_NAME, aliases: ['FileEdit'] },
      input,
      input.file_path,
      permCtx,
    )
  },

  async validateInput(input, context) {
    if (input.old_string === input.new_string) {
      return {
        result: false,
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        errorCode: FILE_EDIT_ERROR_CODES.NO_OP,
      }
    }

    const fullPath = expandPath(input.file_path)

    if (extname(fullPath).toLowerCase() === '.ipynb') {
      return {
        result: false,
        message:
          'Use the NotebookEdit tool to edit Jupyter notebook (.ipynb) files instead of Edit.',
        errorCode: FILE_EDIT_ERROR_CODES.NOTEBOOK_REDIRECT,
      }
    }

    const fsImpl = getFsImplementation()
    let fileExists = false
    let currentMtime = 0
    try {
      const stats = fsImpl.statSync(fullPath)
      fileExists = true
      currentMtime = Math.floor(stats.mtimeMs)
    } catch (error) {
      if (!isEnoent(error)) {
        return {
          result: false,
          message: `Cannot access ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: FILE_EDIT_ERROR_CODES.FILE_NOT_FOUND,
        }
      }
    }

    // Creating a brand-new file with empty old_string
    if (!fileExists) {
      if (input.old_string === '') {
        const secretError = checkTeamMemSecrets(fullPath, input.new_string)
        if (secretError) {
          return {
            result: false,
            message: secretError,
            errorCode: FILE_EDIT_ERROR_CODES.INVALID_SETTINGS_JSON,
          }
        }
        const settingsCheck = validateInputForSettingsFileEdit(
          fullPath,
          input.new_string,
        )
        if (!settingsCheck.valid) {
          return {
            result: false,
            message: settingsCheck.message,
            errorCode: FILE_EDIT_ERROR_CODES.INVALID_SETTINGS_JSON,
          }
        }
        return { result: true }
      }
      const similar = findSimilarFile(fullPath)
      return {
        result: false,
        message: `File does not exist: ${fullPath}${similar ? `. Did you mean ${similar}?` : ''}`,
        errorCode: FILE_EDIT_ERROR_CODES.FILE_NOT_FOUND,
      }
    }

    // Existing file: read-before-edit + partial-read + staleness checks
    const readState = context.readFileState?.get(fullPath)
    if (!readState) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        errorCode: FILE_EDIT_ERROR_CODES.FILE_NOT_READ,
      }
    }

    if (readState.isPartialView) {
      return {
        result: false,
        message:
          'File was only partially read (offset/limit or truncated). Read the full file before editing it.',
        errorCode: FILE_EDIT_ERROR_CODES.PARTIAL_READ,
      }
    }

    const encoding = detectFileEncoding(fullPath)
    const rawDiskContent = fsImpl.readFileSync(fullPath, { encoding })
    const normalizedDisk = normalizeCrLf(
      rawDiskContent.charCodeAt(0) === 0xfeff
        ? rawDiskContent.slice(1)
        : rawDiskContent,
    )

    if (currentMtime > readState.timestamp) {
      const isFullReadMatch =
        readState.offset === undefined &&
        readState.limit === undefined &&
        normalizeCrLf(readState.content) === normalizedDisk
      if (!isFullReadMatch) {
        return {
          result: false,
          message:
            'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
          errorCode: FILE_EDIT_ERROR_CODES.FILE_MODIFIED_EXTERNALLY,
        }
      }
    }

    if (input.old_string === '' && normalizedDisk.length > 0) {
      return {
        result: false,
        message:
          'Cannot create new file — file already exists and is non-empty. Provide old_string to edit it or use Write.',
        errorCode: FILE_EDIT_ERROR_CODES.FILE_EXISTS_FOR_CREATE,
      }
    }

    const actualOld = findActualString(normalizedDisk, input.old_string)
    if (actualOld === null) {
      return {
        result: false,
        message: `String to replace not found in file ${fullPath}.\nString: ${input.old_string}`,
        errorCode: FILE_EDIT_ERROR_CODES.STRING_NOT_FOUND,
      }
    }

    const replaceAll = Boolean(input.replace_all)
    if (!replaceAll && actualOld.length > 0) {
      const occurrences = countOccurrences(normalizedDisk, actualOld)
      if (occurrences > 1) {
        return {
          result: false,
          message: `Found ${occurrences} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context to uniquely identify the match.`,
          errorCode: FILE_EDIT_ERROR_CODES.MULTIPLE_MATCHES,
        }
      }
    }

    const actualNew = preserveQuoteStyle(
      input.old_string,
      actualOld,
      input.new_string,
    )
    const preview = applyStringEdit(
      normalizedDisk,
      actualOld,
      actualNew,
      replaceAll,
    )
    const secretError = checkTeamMemSecrets(fullPath, preview)
    if (secretError) {
      return {
        result: false,
        message: secretError,
        errorCode: FILE_EDIT_ERROR_CODES.INVALID_SETTINGS_JSON,
      }
    }
    const settingsCheck = validateInputForSettingsFileEdit(fullPath, preview)
    if (!settingsCheck.valid) {
      return {
        result: false,
        message: settingsCheck.message,
        errorCode: FILE_EDIT_ERROR_CODES.INVALID_SETTINGS_JSON,
      }
    }

    return { result: true }
  },

  async call(input, context: ToolUseContext, _canUseTool, parentMessage) {
    const fullPath = expandPath(input.file_path)
    const fsImpl = getFsImplementation()
    const replaceAll = Boolean(input.replace_all)

    const exists = fsImpl.existsSync(fullPath)
    const encoding: BufferEncoding = exists
      ? detectFileEncoding(fullPath)
      : 'utf8'
    const endings = exists ? detectLineEndings(fullPath, encoding) : 'LF'

    const rawOriginal = exists ? fsImpl.readFileSync(fullPath, { encoding }) : ''
    const hasBom = rawOriginal.charCodeAt(0) === 0xfeff
    const normalizedOriginal = normalizeCrLf(
      hasBom ? rawOriginal.slice(1) : rawOriginal,
    )

    const actualOld =
      input.old_string === ''
        ? ''
        : (findActualString(normalizedOriginal, input.old_string) ??
          input.old_string)
    const actualNew = preserveQuoteStyle(
      input.old_string,
      actualOld,
      input.new_string,
    )

    const updatedNormalized = applyStringEdit(
      normalizedOriginal,
      actualOld,
      actualNew,
      replaceAll,
    )

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
    writeTextContent(
      fullPath,
      (hasBom ? '\uFEFF' : '') + updatedNormalized,
      encoding,
      endings,
    )

    if (isTeamMemPath(fullPath)) {
      notifyTeamMemoryWrite()
    }

    if (!isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)) {
      const cwd = getCwd()
      const newDirs = await discoverSkillDirsForPaths([fullPath], cwd).catch(
        () => [] as string[],
      )
      if (newDirs.length > 0) {
        await addSkillDirectories(newDirs).catch(() => {})
      }
      activateConditionalSkillsForPaths([fullPath], cwd)
    }

    const lspManager = getLspServerManager()
    if (lspManager) {
      clearDeliveredDiagnosticsForFile(fullPath)
      void lspManager
        .changeFile(fullPath, updatedNormalized)
        .then(() => lspManager.saveFile(fullPath, updatedNormalized))
        .catch(() => {})
    }

    const newMtime = getFileModificationTime(fullPath)
    context.readFileState?.set(fullPath, {
      content: updatedNormalized,
      timestamp: newMtime,
      isPartialView: false,
    })

    const structuredPatch = getPatchFromContents({
      filePath: fullPath,
      oldContent: normalizedOriginal,
      newContent: updatedNormalized,
    })
    const { added, removed } = countLinesChanged(structuredPatch)
    addToTotalLinesChanged(added, removed)

    logFileOperation({
      operation: 'edit',
      tool: FILE_EDIT_TOOL_NAME,
      filePath: fullPath,
      content: updatedNormalized,
      linesAdded: added,
      linesRemoved: removed,
      success: true,
    })

    return {
      data: {
        filePath: fullPath,
        oldString: actualOld,
        newString: actualNew,
        originalFile: normalizedOriginal,
        structuredPatch,
        userModified: false,
        replaceAll,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    const suffix = output.replaceAll
      ? `All occurrences of the specified string have been replaced in ${output.filePath}.`
      : `The file ${output.filePath} has been updated successfully.`
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: suffix,
    }
  },
})
