/**
 * Reconstructed LSP protocol, server configuration, and passive diagnostic
 * domain types (`src/services/lsp/types.ts`).
 */

import type { ConfigScope, LspServerConfig } from '../../types/forward.js'

export type { LspServerConfig }

export type ScopedLspServerConfig = LspServerConfig & {
  scope: ConfigScope
  source: string
}

export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspLocationLink {
  originSelectionRange?: LspRange
  targetUri: string
  targetRange: LspRange
  targetSelectionRange: LspRange
}

export interface LspMarkupContent {
  kind: 'plaintext' | 'markdown'
  value: string
}

export type LspMarkedString = string | { language: string; value: string }

export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[]
  range?: LspRange
}

export type LspSymbolKind =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26

export interface LspDocumentSymbol {
  name: string
  detail?: string
  kind: LspSymbolKind
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}

export interface LspSymbolInformation {
  name: string
  kind: LspSymbolKind
  location: LspLocation
  containerName?: string
}

export interface LspCallHierarchyItem {
  name: string
  kind: LspSymbolKind
  tags?: number[]
  detail?: string
  uri: string
  range: LspRange
  selectionRange: LspRange
  data?: unknown
}

export interface LspCallHierarchyIncomingCall {
  from: LspCallHierarchyItem
  fromRanges: LspRange[]
}

export interface LspCallHierarchyOutgoingCall {
  to: LspCallHierarchyItem
  fromRanges: LspRange[]
}

export interface PublishDiagnosticsParams {
  uri: string
  version?: number
  diagnostics: Array<{
    range: LspRange
    severity?: number
    code?: number | string
    source?: string
    message: string
  }>
}

export interface LspInitializeParams {
  processId: number | null
  initializationOptions?: unknown
  rootPath?: string | null
  rootUri: string | null
  workspaceFolders?: Array<{ uri: string; name: string }> | null
  capabilities: Record<string, unknown>
}

export interface LspInitializeResult {
  capabilities: Record<string, unknown>
  serverInfo?: { name: string; version?: string }
}
