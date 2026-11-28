/**
 * `FileReadTool` (`Read`):
 * - Line-numbered text reading with pagination (`offset`/`limit`), long-line
 *   truncation, and unchanged-file deduplication (`file_unchanged` stub).
 * - Image validation + token-budget resizing, PDF pagination, Jupyter `.ipynb`
 *   parsing.
 * - Security guards: UNC path rejection, blocking-device / FIFO / socket
 *   protection, binary extension checks, read permission rules.
 * - Opts out of `toolResultStorage` spilling via `maxResultSizeChars: Infinity`
 *   and records every read in `context.readFileState`.
 */

import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { readFile } from 'fs/promises'
import { extname } from 'path'
import { z } from 'zod/v4'
import { FILE_READ_TOOL_NAME } from '../../constants/tools.js'
import { memoryFreshnessNote } from '../../memdir/memory_age.js'
import { isAutoMemPath } from '../../memdir/paths.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import type { ImageDimensions } from '../../types/forward.js'
import type { NotebookCellSource } from '../../types/notebook.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { getCwd } from '../../utilities/cwd.js'
import { isEnoent } from '../../utilities/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  suggestPathUnderCwd,
} from '../../utilities/file.js'
import { logFileOperation } from '../../utilities/file_operation_analytics.js'
import { getFsImplementation } from '../../utilities/fs_operations.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBuffer,
} from '../../utilities/image_resizer.js'
import {
  isImageExtension,
  type SupportedImageMediaType,
  validateImageBuffer,
} from '../../utilities/image_validation.js'
import {
  mapNotebookCellsToToolResult,
  readNotebook,
} from '../../utilities/notebook.js'
import { expandPath } from '../../utilities/path.js'
import { readPdf } from '../../utilities/pdf.js'
import { isPdfExtension, parsePdfPageRange } from '../../utilities/pdf_utils.js'
import { checkReadPermissionForTool } from '../../utilities/permissions/rule_matching.js'
import {
  FileTooLargeError,
  readFileInRange,
} from '../../utilities/read_file_in_range.js'
import {
  BINARY_EXTENSIONS,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_READ_LINE_LIMIT,
  isBlockingDevicePath,
  isUncPath,
  MAX_LINE_DISPLAY_LENGTH,
  MAX_READ_CHARS_ESTIMATE,
} from './limits.js'
import { FILE_READ_TOOL_DESCRIPTION, FILE_READ_TOOL_PROMPT } from './prompt.js'

const FileReadInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The 1-based line number to start reading from'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The maximum number of lines to read'),
  pages: z
    .string()
    .optional()
    .describe('Page range for PDF files (e.g. "1-5", "3", max 20 pages)'),
})

export type FileReadInput = z.infer<typeof FileReadInputSchema>

export type FileReadOutput =
  | {
      type: 'text'
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
        truncatedByBytes?: boolean
        freshnessNote?: string
      }
    }
  | {
      type: 'file_unchanged'
      file: {
        filePath: string
      }
    }
  | {
      type: 'image'
      file: {
        base64: string
        type: SupportedImageMediaType
        originalSize: number
        dimensions?: ImageDimensions
      }
    }
  | {
      type: 'notebook'
      file: {
        filePath: string
        cells: NotebookCellSource[]
      }
    }
  | {
      type: 'pdf'
      file: {
        filePath: string
        base64: string
        originalSize: number
        pageCount?: number
      }
    }

function truncateLongLines(content: string): string {
  if (!content) return content
  return content
    .split('\n')
    .map(line =>
      line.length > MAX_LINE_DISPLAY_LENGTH
        ? line.slice(0, MAX_LINE_DISPLAY_LENGTH) + '… [line truncated]'
        : line,
    )
    .join('\n')
}

export const FileReadTool = buildTool<FileReadInput, FileReadOutput>({
  name: FILE_READ_TOOL_NAME,
  aliases: ['FileRead'],
  searchHint: 'read file contents, images, PDFs, or Jupyter notebooks',
  maxResultSizeChars: Infinity,
  inputSchema: FileReadInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
  interruptBehavior: () => 'cancel',

  getPath(input) {
    return input.file_path
  },

  backfillObservableInput(input) {
    if (typeof input.file_path === 'string' && input.file_path.trim()) {
      input.file_path = expandPath(input.file_path)
    }
  },

  toAutoClassifierInput(input) {
    return input.file_path
  },

  userFacingName(input) {
    return input?.file_path ? `Read(${input.file_path})` : FILE_READ_TOOL_NAME
  },

  async description() {
    return FILE_READ_TOOL_DESCRIPTION
  },

  async prompt() {
    return FILE_READ_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    return checkReadPermissionForTool(
      { name: FILE_READ_TOOL_NAME, aliases: ['FileRead'] },
      input,
      input.file_path,
      permCtx,
    )
  },

  async validateInput(input) {
    const rawPath = input.file_path
    if (!rawPath || !rawPath.trim()) {
      return {
        result: false,
        message: 'file_path must be a non-empty path.',
        errorCode: 1,
      }
    }

    if (isUncPath(rawPath)) {
      return {
        result: false,
        message: `Refusing to read UNC network path: ${rawPath}`,
        errorCode: 2,
      }
    }

    const fullPath = expandPath(rawPath)
    if (isBlockingDevicePath(fullPath)) {
      return {
        result: false,
        message: `Refusing to read blocking device file: ${fullPath}`,
        errorCode: 3,
      }
    }

    if (input.pages !== undefined) {
      if (!isPdfExtension(fullPath)) {
        return {
          result: false,
          message: 'The `pages` parameter is only supported for PDF files.',
          errorCode: 4,
        }
      }
      const parsed = parsePdfPageRange(input.pages)
      if (!parsed.ok) {
        return {
          result: false,
          message: parsed.error,
          errorCode: 5,
        }
      }
    }

    const fsImpl = getFsImplementation()
    let lstats
    try {
      lstats = fsImpl.lstatSync(fullPath)
    } catch (error) {
      if (isEnoent(error)) {
        const similar = findSimilarFile(fullPath)
        const suggested = await suggestPathUnderCwd(fullPath)
        let msg = `File does not exist: ${fullPath}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
        if (similar) {
          msg += ` Did you mean ${similar}?`
        } else if (suggested) {
          msg += ` Did you mean ${suggested}?`
        }
        return { result: false, message: msg, errorCode: 6 }
      }
      return {
        result: false,
        message: `Unable to access ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 7,
      }
    }

    if (
      lstats.isFIFO() ||
      lstats.isSocket() ||
      lstats.isCharacterDevice() ||
      lstats.isBlockDevice()
    ) {
      return {
        result: false,
        message: `Refusing to read special device/FIFO/socket file: ${fullPath}`,
        errorCode: 3,
      }
    }

    let stats = lstats
    if (lstats.isSymbolicLink()) {
      try {
        stats = fsImpl.statSync(fullPath)
      } catch (error) {
        return {
          result: false,
          message: `Broken symlink at ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: 6,
        }
      }
    }

    if (stats.isDirectory()) {
      return {
        result: false,
        message: `Path is a directory, not a file: ${fullPath}. Use Glob to list files in a directory.`,
        errorCode: 8,
      }
    }

    const ext = extname(fullPath).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) {
      return {
        result: false,
        message: `Cannot read binary file with extension "${ext}": ${fullPath}`,
        errorCode: 9,
      }
    }

    return { result: true }
  },

  async call(input, context: ToolUseContext) {
    const fullPath = expandPath(input.file_path)
    const ext = extname(fullPath).toLowerCase()
    const fsImpl = getFsImplementation()
    const stats = fsImpl.statSync(fullPath)
    const mtimeMs = Math.floor(stats.mtimeMs)

    // 1. Image files
    if (isImageExtension(ext)) {
      const buffer = await readFile(fullPath)
      const check = validateImageBuffer(buffer)
      if (!check.valid) {
        throw new Error(check.error ?? `Invalid image file: ${fullPath}`)
      }
      const resized = await maybeResizeAndDownsampleImageBuffer(
        buffer,
        check.mediaType,
      )
      context.readFileState?.set(fullPath, {
        content: `[image:${resized.mediaType}]`,
        timestamp: mtimeMs,
        isPartialView: false,
      })
      logFileOperation({
        operation: 'read',
        tool: FILE_READ_TOOL_NAME,
        filePath: fullPath,
        success: true,
      })
      return {
        data: {
          type: 'image',
          file: {
            base64: resized.base64,
            type: resized.mediaType,
            originalSize: resized.originalSize,
            ...(resized.dimensions ? { dimensions: resized.dimensions } : {}),
          },
        },
      }
    }

    // 2. PDF files
    if (isPdfExtension(fullPath)) {
      const pdf = await readPdf(fullPath, input.pages)
      context.readFileState?.set(fullPath, {
        content: `[pdf:${pdf.pageCount ?? 'unknown'}]`,
        timestamp: mtimeMs,
        isPartialView: Boolean(input.pages),
      })
      logFileOperation({
        operation: 'read',
        tool: FILE_READ_TOOL_NAME,
        filePath: fullPath,
        success: true,
      })
      return {
        data: {
          type: 'pdf',
          file: {
            filePath: fullPath,
            base64: pdf.base64,
            originalSize: pdf.originalSize,
            ...(pdf.pageCount !== undefined ? { pageCount: pdf.pageCount } : {}),
          },
        },
      }
    }

    // 3. Jupyter notebooks (.ipynb)
    if (ext === '.ipynb') {
      const { cells, rawContent } = await readNotebook(fullPath)
      context.readFileState?.set(fullPath, {
        content: rawContent,
        timestamp: mtimeMs,
        isPartialView: false,
      })
      logFileOperation({
        operation: 'read',
        tool: FILE_READ_TOOL_NAME,
        filePath: fullPath,
        content: rawContent,
        success: true,
      })
      return {
        data: {
          type: 'notebook',
          file: {
            filePath: fullPath,
            cells,
          },
        },
      }
    }

    // 4. Text file unchanged deduplication
    const effectiveOffset = input.offset
    const effectiveLimit = input.limit
    const cached = context.readFileState?.get(fullPath)
    if (
      cached &&
      cached.timestamp === mtimeMs &&
      cached.offset === effectiveOffset &&
      cached.limit === effectiveLimit &&
      !cached.isPartialView
    ) {
      return {
        data: {
          type: 'file_unchanged',
          file: { filePath: fullPath },
        },
      }
    }

    // 5. Text file read (with default 2,000-line & byte limits)
    const startLine = effectiveOffset ?? 1
    const lineLimit = effectiveLimit ?? DEFAULT_READ_LINE_LIMIT
    const hasExplicitRange =
      effectiveOffset !== undefined || effectiveLimit !== undefined

    let result
    try {
      result = await readFileInRange(fullPath, {
        offset: startLine,
        limit: lineLimit,
        maxSizeBytes: DEFAULT_MAX_READ_BYTES,
        truncateOnByteLimit: true,
      })
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        throw error
      }
      throw error
    }

    if (
      !hasExplicitRange &&
      result.content.length > MAX_READ_CHARS_ESTIMATE
    ) {
      throw new Error(
        `File content (${Math.ceil(result.content.length / 4)} estimated tokens) exceeds maximum allowed tokens (${MAX_READ_CHARS_ESTIMATE / 4}). Use offset and limit parameters to read specific sections of the file.`,
      )
    }

    const isPartialView =
      result.truncatedByBytes ||
      startLine > 1 ||
      (result.totalLines > 0 && result.lineCount < result.totalLines)

    context.readFileState?.set(fullPath, {
      content: result.content,
      timestamp: result.mtimeMs,
      ...(effectiveOffset !== undefined ? { offset: effectiveOffset } : {}),
      ...(effectiveLimit !== undefined ? { limit: effectiveLimit } : {}),
      isPartialView,
    })
    context.nestedMemoryAttachmentTriggers?.add(fullPath)
    const freshnessNote = isAutoMemPath(fullPath)
      ? memoryFreshnessNote(result.mtimeMs)
      : ''

    logFileOperation({
      operation: 'read',
      tool: FILE_READ_TOOL_NAME,
      filePath: fullPath,
      content: result.content,
      success: true,
    })

    return {
      data: {
        type: 'text',
        file: {
          filePath: fullPath,
          content: result.content,
          numLines: result.lineCount,
          startLine,
          totalLines: result.totalLines,
          ...(result.truncatedByBytes ? { truncatedByBytes: true } : {}),
          ...(freshnessNote ? { freshnessNote } : {}),
        },
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    switch (output.type) {
      case 'file_unchanged':
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `File ${output.file.filePath} has not changed since it was last read.`,
        }

      case 'image': {
        const blocks: ContentBlockParam[] = [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: output.file.type,
              data: output.file.base64,
            },
          },
        ]
        const meta = createImageMetadataText(output.file.dimensions)
        if (meta) {
          blocks.push({ type: 'text', text: meta })
        }
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: blocks as ToolResultBlockParam['content'],
        }
      }

      case 'pdf':
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: output.file.base64,
              },
            } as unknown as ContentBlockParam,
          ] as ToolResultBlockParam['content'],
        }

      case 'notebook':
        return mapNotebookCellsToToolResult(output.file.cells, toolUseId)

      case 'text': {
        const {
          content,
          startLine,
          numLines,
          totalLines,
          truncatedByBytes,
          freshnessNote,
        } = output.file
        if (totalLines === 0 && content.length === 0) {
          return {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content:
              '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
          }
        }
        if (numLines === 0 && startLine > totalLines) {
          return {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `<system-reminder>Warning: offset ${startLine} exceeds file length (${totalLines} lines).</system-reminder>`,
          }
        }
        const display = addLineNumbers({
          content: truncateLongLines(content),
          startLine,
        })
        const prefix = freshnessNote ? `${freshnessNote}\n` : ''
        const notes: string[] = []
        if (truncatedByBytes) {
          notes.push(
            `Output truncated at byte limit after line ${startLine + numLines - 1} of ${totalLines}. Use offset=${startLine + numLines} to continue reading.`,
          )
        } else if (startLine + numLines - 1 < totalLines) {
          notes.push(
            `Showing lines ${startLine}-${startLine + numLines - 1} of ${totalLines}. Use offset=${startLine + numLines} to read more.`,
          )
        }
        const suffix =
          notes.length > 0
            ? `\n<system-reminder>${notes.join(' ')}</system-reminder>`
            : ''
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: prefix + display + suffix,
        }
      }
    }
  },
})
