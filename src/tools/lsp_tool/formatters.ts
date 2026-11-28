/**
 * Human- and model-readable formatters for all 9 `LSPTool` operations,
 * converting 0-based LSP coordinates back to 1-based `line:character` editor
 * positions.
 */

import { relative } from 'path'
import { fileURLToPath } from 'url'
import type {
  LspCallHierarchyIncomingCall,
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspMarkedString,
  LspSymbolInformation,
  LspSymbolKind,
} from '../../services/lsp/types.js'

const SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
}

export function symbolKindToName(kind: LspSymbolKind | number): string {
  return SYMBOL_KIND_NAMES[kind] ?? 'Symbol'
}

/**
 * Formats a `file://` URI into a clean workspace-relative or absolute path.
 */
export function formatLspUri(uri: string, cwd: string): string {
  let fsPath = uri
  if (uri.startsWith('file://')) {
    try {
      fsPath = fileURLToPath(uri)
    } catch {
      fsPath = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''))
    }
  }
  const rel = relative(cwd, fsPath).replace(/\\/g, '/')
  if (rel && !rel.startsWith('../../') && !rel.includes(':')) {
    return rel
  }
  return fsPath.replace(/\\/g, '/')
}

export function normalizeLocationItem(
  item: LspLocation | LspLocationLink,
): LspLocation {
  if ('targetUri' in item) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange ?? item.targetRange,
    }
  }
  return item
}

/**
 * Formats `goToDefinition`, `findReferences`, or `goToImplementation` locations.
 */
export function formatLocationsResult(
  raw: LspLocation | Array<LspLocation | LspLocationLink> | null | undefined,
  cwd: string,
  emptyMessage: string,
): { text: string; resultCount: number; fileCount: number } {
  if (!raw) {
    return { text: emptyMessage, resultCount: 0, fileCount: 0 }
  }
  const list = (Array.isArray(raw) ? raw : [raw]).map(normalizeLocationItem)
  if (list.length === 0) {
    return { text: emptyMessage, resultCount: 0, fileCount: 0 }
  }

  const files = new Set<string>()
  const lines = list.map(loc => {
    const fileLabel = formatLspUri(loc.uri, cwd)
    files.add(fileLabel)
    const line1 = loc.range.start.line + 1
    const char1 = loc.range.start.character + 1
    return `${fileLabel}:${line1}:${char1}`
  })

  return {
    text: lines.join('\n'),
    resultCount: list.length,
    fileCount: files.size,
  }
}

function formatMarkedString(item: LspMarkedString): string {
  if (typeof item === 'string') {
    return item
  }
  return `\`\`\`${item.language}\n${item.value}\n\`\`\``
}

/**
 * Formats `textDocument/hover` results.
 */
export function formatHoverResult(hover: LspHover | null | undefined): {
  text: string
  resultCount: number
} {
  if (!hover || !hover.contents) {
    return { text: 'No hover information available at this position.', resultCount: 0 }
  }
  const { contents } = hover
  let body = ''
  if (Array.isArray(contents)) {
    body = contents.map(formatMarkedString).filter(Boolean).join('\n\n')
  } else if (typeof contents === 'object' && 'kind' in contents) {
    body = contents.value
  } else {
    body = formatMarkedString(contents)
  }
  if (!body.trim()) {
    return { text: 'No hover information available at this position.', resultCount: 0 }
  }
  return { text: body.trim(), resultCount: 1 }
}

function renderDocumentSymbolTree(
  symbols: readonly LspDocumentSymbol[],
  depth = 0,
): { lines: string[]; count: number } {
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  let count = 0

  for (const sym of symbols) {
    count++
    const line1 = sym.selectionRange.start.line + 1
    const char1 = sym.selectionRange.start.character + 1
    const detail = sym.detail ? ` — ${sym.detail}` : ''
    lines.push(
      `${indent}${symbolKindToName(sym.kind)} ${sym.name} (line ${line1}:${char1})${detail}`,
    )
    if (sym.children && sym.children.length > 0) {
      const nested = renderDocumentSymbolTree(sym.children, depth + 1)
      lines.push(...nested.lines)
      count += nested.count
    }
  }
  return { lines, count }
}

/**
 * Formats `documentSymbol` (`DocumentSymbol[]` or `SymbolInformation[]`) or
 * `workspaceSymbol` (`SymbolInformation[]`) results.
 */
export function formatSymbolsResult(
  raw: Array<LspDocumentSymbol | LspSymbolInformation> | null | undefined,
  cwd: string,
  includeFileUri: boolean,
): { text: string; resultCount: number; fileCount: number } {
  if (!raw || raw.length === 0) {
    return { text: 'No symbols found.', resultCount: 0, fileCount: 0 }
  }

  const first = raw[0]!
  if ('selectionRange' in first && !includeFileUri) {
    const tree = renderDocumentSymbolTree(raw as LspDocumentSymbol[])
    return {
      text: tree.lines.join('\n'),
      resultCount: tree.count,
      fileCount: 1,
    }
  }

  const files = new Set<string>()
  const lines = (raw as LspSymbolInformation[]).map(sym => {
    const fileLabel = formatLspUri(sym.location.uri, cwd)
    files.add(fileLabel)
    const line1 = sym.location.range.start.line + 1
    const char1 = sym.location.range.start.character + 1
    const container = sym.containerName ? ` (in ${sym.containerName})` : ''
    return `${fileLabel}:${line1}:${char1} — ${symbolKindToName(sym.kind)} ${sym.name}${container}`
  })

  return {
    text: lines.join('\n'),
    resultCount: lines.length,
    fileCount: files.size,
  }
}

/**
 * Formats `prepareCallHierarchy`, `incomingCalls`, and `outgoingCalls`.
 */
export function formatCallHierarchyResult(
  operation: 'prepareCallHierarchy' | 'incomingCalls' | 'outgoingCalls',
  raw: unknown,
  cwd: string,
): { text: string; resultCount: number; fileCount: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      text: 'No call hierarchy items found.',
      resultCount: 0,
      fileCount: 0,
    }
  }

  const files = new Set<string>()
  if (operation === 'prepareCallHierarchy') {
    const items = raw as LspCallHierarchyItem[]
    const lines = items.map(item => {
      const f = formatLspUri(item.uri, cwd)
      files.add(f)
      return `${symbolKindToName(item.kind)} ${item.name} — ${f}:${item.selectionRange.start.line + 1}:${item.selectionRange.start.character + 1}`
    })
    return { text: lines.join('\n'), resultCount: items.length, fileCount: files.size }
  }

  if (operation === 'incomingCalls') {
    const items = raw as LspCallHierarchyIncomingCall[]
    const lines = items.map(entry => {
      const f = formatLspUri(entry.from.uri, cwd)
      files.add(f)
      const sites = entry.fromRanges
        .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
        .join(', ')
      return `${symbolKindToName(entry.from.kind)} ${entry.from.name} (${f}:${entry.from.selectionRange.start.line + 1}) [calls at: ${sites}]`
    })
    return { text: lines.join('\n'), resultCount: items.length, fileCount: files.size }
  }

  const items = raw as LspCallHierarchyOutgoingCall[]
  const lines = items.map(entry => {
    const f = formatLspUri(entry.to.uri, cwd)
    files.add(f)
    const sites = entry.fromRanges
      .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
      .join(', ')
    return `${symbolKindToName(entry.to.kind)} ${entry.to.name} (${f}:${entry.to.selectionRange.start.line + 1}) [called from: ${sites}]`
  })
  return { text: lines.join('\n'), resultCount: items.length, fileCount: files.size }
}
