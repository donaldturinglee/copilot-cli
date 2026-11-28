/**
 * Subscribes to `textDocument/publishDiagnostics` notifications on all managed
 * LSP servers and feeds normalized `DiagnosticFile` records into
 * `lsp_diagnostic_registry`.
 */

import { fileURLToPath } from 'url'
import { logForDebugging } from '../../utilities/debug.js'
import { registerPendingLspDiagnostic } from './lsp_diagnostic_registry.js'
import type { LSPServerManager } from './lsp_server_manager.js'
import type { Diagnostic, DiagnosticFile, PublishDiagnosticsParams } from './types.js'

function mapSeverity(code?: number): Diagnostic['severity'] {
  switch (code) {
    case 1:
      return 'Error'
    case 2:
      return 'Warning'
    case 3:
      return 'Info'
    case 4:
      return 'Hint'
    default:
      return 'Error'
  }
}

/**
 * Converts raw LSP `PublishDiagnosticsParams` into internal `DiagnosticFile[]`.
 */
export function formatDiagnosticsForAttachment(
  params: PublishDiagnosticsParams,
): DiagnosticFile[] {
  if (!Array.isArray(params.diagnostics) || params.diagnostics.length === 0) {
    return []
  }

  let displayPath = params.uri
  if (params.uri.startsWith('file://')) {
    try {
      displayPath = fileURLToPath(params.uri)
    } catch {
      displayPath = params.uri
    }
  }

  const diagnostics: Diagnostic[] = params.diagnostics.map(item => ({
    message: item.message,
    severity: mapSeverity(item.severity),
    range: item.range,
    ...(item.source ? { source: item.source } : {}),
    ...(item.code !== undefined && item.code !== null
      ? { code: String(item.code) }
      : {}),
  }))

  return [{ uri: displayPath, diagnostics }]
}

/**
 * Attaches `textDocument/publishDiagnostics` listeners across every server in
 * `manager`.
 */
export function registerLspNotificationHandlers(
  manager: LSPServerManager,
): void {
  for (const server of manager.getAllServers()) {
    let consecutiveErrors = 0
    server.client.onNotification<PublishDiagnosticsParams>(
      'textDocument/publishDiagnostics',
      params => {
        try {
          const files = formatDiagnosticsForAttachment(params)
          consecutiveErrors = 0
          if (files.length > 0) {
            registerPendingLspDiagnostic({
              serverName: server.name,
              files,
            })
          }
        } catch (error) {
          consecutiveErrors++
          if (consecutiveErrors >= 3) {
            logForDebugging(
              `LSP passive diagnostics handler failed ${consecutiveErrors} times on "${server.name}": ${String(error)}`,
              { level: 'warn' },
            )
          }
        }
      },
    )
  }
}

export const registerLSPNotificationHandlers = registerLspNotificationHandlers
