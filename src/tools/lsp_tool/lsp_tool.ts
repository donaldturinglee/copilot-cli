/**
 * `LSPTool` (`LSP`): executes all 9 LSP navigation, hover, symbol, and
 * call-hierarchy operations with 1-based -> 0-based coordinate conversion,
 * automatic `didOpen` synchronization, and `git check-ignore` filtering.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { LSP_TOOL_NAME } from '../../constants/tools.js'
import {
  getInitializationStatus,
  getLspServerManager,
  isLspConnected,
  waitForInitialization,
} from '../../services/lsp/manager.js'
import type {
  LspCallHierarchyItem,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspSymbolInformation,
} from '../../services/lsp/types.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { getCwd } from '../../utilities/cwd.js'
import { isEnoent } from '../../utilities/errors.js'
import { execFileNoThrowWithCwd } from '../../utilities/exec_file_no_throw.js'
import { expandPath } from '../../utilities/path.js'
import { checkReadPermissionForTool } from '../../utilities/permissions/rule_matching.js'
import {
  formatCallHierarchyResult,
  formatHoverResult,
  formatLocationsResult,
  formatSymbolsResult,
  normalizeLocationItem,
} from './formatters.js'
import { LSP_TOOL_DESCRIPTION, LSP_TOOL_PROMPT } from './prompt.js'
import {
  LspToolInputSchema,
  type LspToolInput,
  type LspToolOutput,
} from './schemas.js'

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000
const MAX_LSP_RESULT_CHARS = 100_000

function hasEnclosingGitRepo(startDir: string): boolean {
  let cursor = resolve(startDir)
  while (true) {
    if (existsSync(join(cursor, '.git'))) {
      return true
    }
    const parent = dirname(cursor)
    if (parent === cursor) {
      return false
    }
    cursor = parent
  }
}

async function filterOutGitignoredUris<Item>(
  items: readonly Item[],
  extractUri: (item: Item) => string,
  cwd: string,
): Promise<Item[]> {
  if (items.length === 0 || !hasEnclosingGitRepo(cwd)) {
    return [...items]
  }

  const uriToFsPath = new Map<string, string>()
  for (const item of items) {
    const uri = extractUri(item)
    if (!uri.startsWith('file://') || uriToFsPath.has(uri)) continue
    try {
      uriToFsPath.set(uri, fileURLToPath(uri))
    } catch {
      // Keep non-convertible URIs
    }
  }

  const allPaths = Array.from(new Set(uriToFsPath.values()))
  if (allPaths.length === 0) {
    return [...items]
  }

  const ignoredSet = new Set<string>()
  for (let i = 0; i < allPaths.length; i += 50) {
    const batch = allPaths.slice(i, i + 50)
    const res = await execFileNoThrowWithCwd(
      'git',
      ['check-ignore', ...batch],
      { cwd, preserveOutputOnError: false, timeout: 5_000 },
    )
    if (res.stdout) {
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed) {
          ignoredSet.add(
            process.platform === 'win32' ? trimmed.toLowerCase() : trimmed,
          )
        }
      }
    }
  }

  if (ignoredSet.size === 0) {
    return [...items]
  }

  return items.filter(item => {
    const fsPath = uriToFsPath.get(extractUri(item))
    if (!fsPath) return true
    const key = process.platform === 'win32' ? fsPath.toLowerCase() : fsPath
    return !ignoredSet.has(key)
  })
}

export const LSPTool = buildTool<LspToolInput, LspToolOutput>({
  name: LSP_TOOL_NAME,
  searchHint: 'code intelligence (definitions, references, symbols, hover, call hierarchy)',
  shouldDefer: true,
  maxResultSizeChars: MAX_LSP_RESULT_CHARS,
  inputSchema: LspToolInputSchema,

  isEnabled: () => isLspConnected(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,

  getPath(input) {
    return input.filePath
  },

  userFacingName(input) {
    return input?.operation ? `LSP(${input.operation})` : LSP_TOOL_NAME
  },

  toAutoClassifierInput(input) {
    return `${input.operation} ${input.filePath}:${input.line}:${input.character}`
  },

  async description() {
    return LSP_TOOL_DESCRIPTION
  },

  async prompt() {
    return LSP_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    return checkReadPermissionForTool(
      { name: LSP_TOOL_NAME },
      input,
      expandPath(input.filePath),
      permCtx,
    )
  },

  async validateInput(input) {
    const parsed = LspToolInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        result: false,
        message: parsed.error.message,
        errorCode: 3,
      }
    }

    const absPath = expandPath(input.filePath)
    if (absPath.startsWith('\\\\') || absPath.startsWith('//')) {
      return { result: true }
    }

    try {
      const stats = await stat(absPath)
      if (!stats.isFile()) {
        return {
          result: false,
          message: `Path is not a regular file: ${absPath}`,
          errorCode: 2,
        }
      }
      return { result: true }
    } catch (error) {
      if (isEnoent(error)) {
        return {
          result: false,
          message: `File does not exist: ${absPath}`,
          errorCode: 1,
        }
      }
      return {
        result: false,
        message: `Cannot stat ${absPath}: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 4,
      }
    }
  },

  async call(input, _context: ToolUseContext) {
    if (getInitializationStatus().status === 'pending') {
      await waitForInitialization()
    }

    const manager = getLspServerManager()
    if (!manager) {
      throw new Error('No LSP server manager is active.')
    }

    const absPath = expandPath(input.filePath)
    const server = manager.getServerForFile(absPath)
    if (!server) {
      throw new Error(`No LSP server configured for file: ${absPath}`)
    }

    if (!manager.isFileOpen(absPath)) {
      const fileStats = await stat(absPath)
      if (fileStats.size > MAX_LSP_FILE_SIZE_BYTES) {
        throw new Error(
          `File ${absPath} exceeds maximum 10MB LSP sync limit (${fileStats.size} bytes)`,
        )
      }
      const content = await readFile(absPath, 'utf8')
      await manager.openFile(absPath, content)
    }

    const cwd = getCwd()
    const uri = pathToFileURL(absPath).href
    // Convert 1-based input coordinates to 0-based LSP Position
    const position = {
      line: input.line - 1,
      character: input.character - 1,
    }

    switch (input.operation) {
      case 'goToDefinition':
      case 'goToImplementation': {
        const method =
          input.operation === 'goToDefinition'
            ? 'textDocument/definition'
            : 'textDocument/implementation'
        const raw = await manager.sendRequest<
          LspLocation | Array<LspLocation | LspLocationLink> | null
        >(absPath, method, { textDocument: { uri }, position })
        const normalized = raw
          ? (Array.isArray(raw) ? raw : [raw]).map(normalizeLocationItem)
          : []
        const filtered = await filterOutGitignoredUris(
          normalized,
          loc => loc.uri,
          cwd,
        )
        const formatted = formatLocationsResult(
          filtered,
          cwd,
          input.operation === 'goToDefinition'
            ? 'No definition found.'
            : 'No implementation found.',
        )
        return {
          data: {
            operation: input.operation,
            result: formatted.text,
            filePath: absPath,
            resultCount: formatted.resultCount,
            fileCount: formatted.fileCount,
          },
        }
      }

      case 'findReferences': {
        const raw = await manager.sendRequest<LspLocation[] | null>(
          absPath,
          'textDocument/references',
          {
            textDocument: { uri },
            position,
            context: { includeDeclaration: true },
          },
        )
        const filtered = await filterOutGitignoredUris(
          raw ?? [],
          loc => loc.uri,
          cwd,
        )
        const formatted = formatLocationsResult(
          filtered,
          cwd,
          'No references found.',
        )
        return {
          data: {
            operation: 'findReferences',
            result: formatted.text,
            filePath: absPath,
            resultCount: formatted.resultCount,
            fileCount: formatted.fileCount,
          },
        }
      }

      case 'hover': {
        const raw = await manager.sendRequest<LspHover | null>(
          absPath,
          'textDocument/hover',
          { textDocument: { uri }, position },
        )
        const formatted = formatHoverResult(raw)
        return {
          data: {
            operation: 'hover',
            result: formatted.text,
            filePath: absPath,
            resultCount: formatted.resultCount,
            fileCount: formatted.resultCount > 0 ? 1 : 0,
          },
        }
      }

      case 'documentSymbol': {
        const raw = await manager.sendRequest<
          Array<LspDocumentSymbol | LspSymbolInformation> | null
        >(absPath, 'textDocument/documentSymbol', { textDocument: { uri } })
        const formatted = formatSymbolsResult(raw, cwd, false)
        return {
          data: {
            operation: 'documentSymbol',
            result: formatted.text,
            filePath: absPath,
            resultCount: formatted.resultCount,
            fileCount: formatted.fileCount,
          },
        }
      }

      case 'workspaceSymbol': {
        const raw = await manager.sendRequest<LspSymbolInformation[] | null>(
          absPath,
          'workspace/symbol',
          { query: '' },
        )
        const filtered = await filterOutGitignoredUris(
          raw ?? [],
          sym => sym.location.uri,
          cwd,
        )
        const formatted = formatSymbolsResult(filtered, cwd, true)
        return {
          data: {
            operation: 'workspaceSymbol',
            result: formatted.text,
            filePath: absPath,
            resultCount: formatted.resultCount,
            fileCount: formatted.fileCount,
          },
        }
      }

      case 'prepareCallHierarchy': {
        const items = await manager.sendRequest<LspCallHierarchyItem[] | null>(
          absPath,
          'textDocument/prepareCallHierarchy',
          { textDocument: { uri }, position },
        )
        const formatted = formatCallHierarchyResult(
          'prepareCallHierarchy',
          items,
          cwd,
        )
        return {
          data: {
            operation: 'prepareCallHierarchy',
            result: formatted.text,
            filePath: absPath,
            resultCount: formatted.resultCount,
            fileCount: formatted.fileCount,
          },
        }
      }

      case 'incomingCalls':
      case 'outgoingCalls': {
        const items = await manager.sendRequest<LspCallHierarchyItem[] | null>(
          absPath,
          'textDocument/prepareCallHierarchy',
          { textDocument: { uri }, position },
        )
        if (!items || items.length === 0) {
          return {
            data: {
              operation: input.operation,
              result: 'No call hierarchy item found at this position',
              filePath: absPath,
              resultCount: 0,
              fileCount: 0,
            },
          }
        }
        const callMethod =
          input.operation === 'incomingCalls'
            ? 'callHierarchy/incomingCalls'
            : 'callHierarchy/outgoingCalls'
        const calls = await manager.sendRequest<unknown[]>(absPath, callMethod, {
          item: items[0],
        })
        const formatted = formatCallHierarchyResult(
          input.operation,
          calls,
          cwd,
        )
        return {
          data: {
            operation: input.operation,
            result: formatted.text,
            filePath: absPath,
            resultCount: formatted.resultCount,
            fileCount: formatted.fileCount,
          },
        }
      }
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: output.result,
    }
  },
})
