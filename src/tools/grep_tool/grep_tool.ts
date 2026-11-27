/**
 * `GrepTool` (`Grep`):
 * Read-only, concurrency-safe ripgrep-backed search supporting `content`,
 * `files_with_matches`, and `count` output modes, context lines, `head_limit`
 * (default 250, `0` = unlimited), `offset`, VCS/permission ignore exclusions,
 * and `maxResultSizeChars: 20_000`.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { GREP_TOOL_NAME } from '../../constants/tools.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { getCwd } from '../../utilities/cwd.js'
import { isEnoent } from '../../utilities/errors.js'
import { getFsImplementation } from '../../utilities/fs_operations.js'
import { VCS_EXCLUDE_GLOBS } from '../../utilities/glob.js'
import { expandPath } from '../../utilities/path.js'
import {
  checkReadPermissionForTool,
  getFileReadIgnorePatterns,
} from '../../utilities/permissions/rule_matching.js'
import { ripGrep } from '../../utilities/ripgrep.js'
import { GREP_TOOL_DESCRIPTION, GREP_TOOL_PROMPT } from './prompt.js'

export const GREP_MAX_RESULT_SIZE_CHARS = 20_000
export const DEFAULT_GREP_HEAD_LIMIT = 250
const DEFAULT_MAX_COLUMNS = 500

const GrepInputSchema = z.object({
  pattern: z
    .string()
    .describe('The regular expression pattern to search for in file contents'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in. Defaults to current working directory.',
    ),
  glob: z
    .string()
    .optional()
    .describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .default('files_with_matches')
    .describe(
      'Output mode: "content", "files_with_matches" (default), or "count"',
    ),
  '-B': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Number of lines to show before each match (content mode)'),
  '-A': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Number of lines to show after each match (content mode)'),
  '-C': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Alias for context (lines before and after each match)'),
  context: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Number of lines to show before and after each match'),
  '-n': z
    .boolean()
    .optional()
    .default(true)
    .describe('Show line numbers in output (content mode, default true)'),
  '-i': z
    .boolean()
    .optional()
    .default(false)
    .describe('Case insensitive search'),
  type: z
    .string()
    .optional()
    .describe('File type to search (e.g. "js", "py", "rust", "ts")'),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Limit output to first N lines/entries (default 250; 0 for unlimited)',
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe('Skip first N lines/entries before applying head_limit'),
  multiline: z
    .boolean()
    .optional()
    .default(false)
    .describe('Enable multiline mode where `.` matches newlines'),
})

export type GrepInput = z.infer<typeof GrepInputSchema>

export interface GrepOutput {
  mode: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
  appliedLimit?: number
  appliedOffset?: number
}

function applyPagination<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { sliced: T[]; truncated: boolean } {
  const afterOffset = offset > 0 ? items.slice(offset) : [...items]
  if (limit === 0) {
    return { sliced: afterOffset, truncated: false }
  }
  const truncated = afterOffset.length > limit
  return {
    sliced: afterOffset.slice(0, limit),
    truncated,
  }
}

function splitGlobPatterns(globArg: string): string[] {
  // Split space-separated glob lists without breaking `{a,b}` braces
  const patterns: string[] = []
  let current = ''
  let braceDepth = 0
  for (const ch of globArg.trim()) {
    if (ch === '{') braceDepth++
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    if (/\s/.test(ch) && braceDepth === 0) {
      if (current) {
        patterns.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) patterns.push(current)
  return patterns
}

function normalizeDisplayPath(filePath: string, baseDir: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(baseDir, filePath)
  const rel = relative(baseDir, abs)
  return rel && !rel.startsWith('..') ? rel : abs
}

export const GrepTool = buildTool<GrepInput, GrepOutput>({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regular expressions (ripgrep)',
  maxResultSizeChars: GREP_MAX_RESULT_SIZE_CHARS,
  inputSchema: GrepInputSchema,

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
    return input?.pattern ? `Grep(${input.pattern})` : GREP_TOOL_NAME
  },

  async description() {
    return GREP_TOOL_DESCRIPTION
  },

  async prompt() {
    return GREP_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    const target = input.path ? expandPath(input.path) : getCwd()
    return checkReadPermissionForTool(
      { name: GREP_TOOL_NAME },
      input,
      target,
      permCtx,
    )
  },

  async validateInput(input) {
    if (!input.pattern) {
      return {
        result: false,
        message: 'Grep pattern must be a non-empty regular expression.',
        errorCode: 1,
      }
    }
    try {
      new RegExp(input.pattern)
    } catch (error) {
      return {
        result: false,
        message: `Invalid regular expression "${input.pattern}": ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 2,
      }
    }
    if (input.path) {
      const target = expandPath(input.path)
      try {
        getFsImplementation().statSync(target)
      } catch (error) {
        if (isEnoent(error)) {
          return {
            result: false,
            message: `Search path does not exist: ${target}`,
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
    const mode = input.output_mode ?? 'files_with_matches'
    const searchTarget = input.path ? expandPath(input.path) : getCwd()
    const effectiveLimit =
      input.head_limit !== undefined
        ? input.head_limit
        : DEFAULT_GREP_HEAD_LIMIT
    const effectiveOffset = input.offset ?? 0

    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    const ignorePatterns = [
      ...getFileReadIgnorePatterns(permCtx, 'Read'),
      ...getFileReadIgnorePatterns(permCtx, GREP_TOOL_NAME),
    ]

    const args: string[] = ['--hidden', '--max-columns', String(DEFAULT_MAX_COLUMNS)]
    for (const vcs of VCS_EXCLUDE_GLOBS) {
      args.push('--glob', vcs)
    }
    for (const pat of ignorePatterns) {
      args.push('--glob', pat.startsWith('!') ? pat : `!${pat}`)
    }

    if (input.multiline) {
      args.push('-U', '--multiline-dotall')
    }
    if (input['-i']) {
      args.push('-i')
    }

    if (mode === 'files_with_matches') {
      args.push('-l')
    } else if (mode === 'count') {
      args.push('-c')
    } else {
      if (input['-n'] !== false) {
        args.push('-n')
      }
      const ctxVal = input.context ?? input['-C']
      if (ctxVal !== undefined) {
        args.push('-C', String(ctxVal))
      } else {
        if (input['-B'] !== undefined) args.push('-B', String(input['-B']))
        if (input['-A'] !== undefined) args.push('-A', String(input['-A']))
      }
    }

    if (input.type) {
      args.push('--type', input.type)
    }
    if (input.glob) {
      for (const globPat of splitGlobPatterns(input.glob)) {
        args.push('--glob', globPat)
      }
    }

    // Prefix pattern with `-e` so patterns starting with `-` are never treated as flags
    args.push('-e', input.pattern)

    const rawLines = await ripGrep(
      args,
      searchTarget,
      context.abortController.signal,
    )

    const cwd = getCwd()

    if (mode === 'content') {
      const { sliced, truncated } = applyPagination(
        rawLines,
        effectiveOffset,
        effectiveLimit,
      )
      const content = sliced.join('\n')
      return {
        data: {
          mode,
          numFiles: 0,
          filenames: [],
          content,
          numLines: sliced.length,
          ...(truncated ? { appliedLimit: effectiveLimit } : {}),
          ...(effectiveOffset > 0 ? { appliedOffset: effectiveOffset } : {}),
        },
      }
    }

    if (mode === 'count') {
      let totalMatches = 0
      const normalized = rawLines.map(line => {
        const lastColon = line.lastIndexOf(':')
        if (lastColon === -1) return line
        const filePart = line.slice(0, lastColon)
        const countPart = Number.parseInt(line.slice(lastColon + 1), 10) || 0
        totalMatches += countPart
        return `${normalizeDisplayPath(filePart, cwd)}:${countPart}`
      })
      const { sliced, truncated } = applyPagination(
        normalized,
        effectiveOffset,
        effectiveLimit,
      )
      return {
        data: {
          mode,
          numFiles: rawLines.length,
          filenames: sliced,
          content: sliced.join('\n'),
          numMatches: totalMatches,
          ...(truncated ? { appliedLimit: effectiveLimit } : {}),
          ...(effectiveOffset > 0 ? { appliedOffset: effectiveOffset } : {}),
        },
      }
    }

    // files_with_matches
    const normalizedPaths = rawLines.map(p => normalizeDisplayPath(p, cwd))
    const { sliced, truncated } = applyPagination(
      normalizedPaths,
      effectiveOffset,
      effectiveLimit,
    )

    return {
      data: {
        mode,
        numFiles: sliced.length,
        filenames: sliced,
        ...(truncated ? { appliedLimit: effectiveLimit } : {}),
        ...(effectiveOffset > 0 ? { appliedOffset: effectiveOffset } : {}),
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    const notes: string[] = []
    if (output.appliedOffset) {
      notes.push(`offset=${output.appliedOffset}`)
    }
    if (output.appliedLimit) {
      notes.push(`limit=${output.appliedLimit}`)
    }
    const paginationNote =
      notes.length > 0
        ? `\n[Results truncated (${notes.join(', ')}). Use offset/head_limit or narrow path/glob.]`
        : ''

    if (output.mode === 'content') {
      if (!output.content) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'No matches found',
        }
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output.content + paginationNote,
      }
    }

    if (output.mode === 'count') {
      if (!output.content) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'No matches found',
        }
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content:
          `${output.content}\n\nFound ${output.numMatches ?? 0} total occurrences across ${output.numFiles} files.` +
          paginationNote,
      }
    }

    if (output.filenames.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'No files found',
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content:
        `Found ${output.filenames.length} file${output.filenames.length === 1 ? '' : 's'}\n` +
        output.filenames.join('\n') +
        paginationNote,
    }
  },
})
