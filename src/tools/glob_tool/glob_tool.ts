/**
 * `GlobTool` (`Glob`):
 * Read-only, concurrency-safe file pattern matching tool returning up to 100
 * matches sorted by modification time descending.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { GLOB_TOOL_NAME } from '../../constants/tools.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { getCwd } from '../../utilities/cwd.js'
import { isEnoent } from '../../utilities/errors.js'
import { getFsImplementation } from '../../utilities/fs_operations.js'
import { glob } from '../../utilities/glob.js'
import { expandPath } from '../../utilities/path.js'
import {
  checkReadPermissionForTool,
  getFileReadIgnorePatterns,
} from '../../utilities/permissions/rule_matching.js'
import { GLOB_TOOL_DESCRIPTION, GLOB_TOOL_PROMPT } from './prompt.js'

const DEFAULT_GLOB_LIMIT = 100
const GLOB_MAX_RESULT_CHARS = 100_000

const GlobInputSchema = z.object({
  pattern: z.string().describe('The glob pattern to match files against'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If omitted, the current working directory is used.',
    ),
})

export type GlobInput = z.infer<typeof GlobInputSchema>

export interface GlobOutput {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
}

export const GlobTool = buildTool<GlobInput, GlobOutput>({
  name: GLOB_TOOL_NAME,
  searchHint: 'find files by glob pattern (e.g. **/*.ts)',
  maxResultSizeChars: GLOB_MAX_RESULT_CHARS,
  inputSchema: GlobInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  interruptBehavior: () => 'cancel',

  getPath(input) {
    return input.path ? expandPath(input.path) : getCwd()
  },

  toAutoClassifierInput(input) {
    return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`
  },

  userFacingName(input) {
    return input?.pattern ? `Glob(${input.pattern})` : GLOB_TOOL_NAME
  },

  async description() {
    return GLOB_TOOL_DESCRIPTION
  },

  async prompt() {
    return GLOB_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    const targetDir = input.path ? expandPath(input.path) : getCwd()
    return checkReadPermissionForTool(
      { name: GLOB_TOOL_NAME },
      input,
      targetDir,
      permCtx,
    )
  },

  async validateInput(input) {
    if (!input.pattern.trim()) {
      return {
        result: false,
        message: 'Glob pattern must be a non-empty string.',
        errorCode: 1,
      }
    }
    if (input.path) {
      const target = expandPath(input.path)
      const fsImpl = getFsImplementation()
      try {
        const stats = fsImpl.statSync(target)
        if (!stats.isDirectory()) {
          return {
            result: false,
            message: `Path is not a directory: ${target}`,
            errorCode: 2,
          }
        }
      } catch (error) {
        if (isEnoent(error)) {
          return {
            result: false,
            message: `Directory does not exist: ${target}`,
            errorCode: 3,
          }
        }
        return {
          result: false,
          message: `Cannot access ${target}: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: 4,
        }
      }
    }
    return { result: true }
  },

  async call(input, context: ToolUseContext) {
    const start = Date.now()
    const searchDir = input.path ? expandPath(input.path) : getCwd()
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    const ignorePatterns = [
      ...getFileReadIgnorePatterns(permCtx, 'Read'),
      ...getFileReadIgnorePatterns(permCtx, GLOB_TOOL_NAME),
    ]

    const { files, truncated } = await glob(
      input.pattern,
      searchDir,
      {
        limit: DEFAULT_GLOB_LIMIT,
        ignorePatterns,
      },
      context.abortController.signal,
    )

    return {
      data: {
        durationMs: Date.now() - start,
        numFiles: files.length,
        filenames: files,
        truncated,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    if (output.filenames.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'No files found',
      }
    }
    let text = output.filenames.join('\n')
    if (output.truncated) {
      text +=
        '\n(Results are truncated. Consider using a more specific path or pattern.)'
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: text,
    }
  },
})
