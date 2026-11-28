/**
 * Deduplicated passive LSP diagnostic registry (`500`-file `LRUCache`, `10`
 * diagnostics per file, `30` diagnostics per batch cap) with normalized
 * URI/filesystem-path key matching.
 */

import { LRUCache } from 'lru-cache'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { jsonStringify } from '../../utilities/slow_operations.js'
import type { Diagnostic, DiagnosticFile } from './types.js'

export const MAX_DIAGNOSTICS_PER_FILE = 10
export const MAX_TOTAL_DIAGNOSTICS = 30
export const MAX_DELIVERED_FILES = 500

export interface PendingLspDiagnostic {
  serverName: string
  files: DiagnosticFile[]
}

const SEVERITY_ORDER: Readonly<Record<Diagnostic['severity'], number>> = {
  Error: 1,
  Warning: 2,
  Info: 3,
  Hint: 4,
}

const pendingDiagnostics = new Map<string, PendingLspDiagnostic>()
const deliveredDiagnostics = new LRUCache<string, Set<string>>({
  max: MAX_DELIVERED_FILES,
})

function normalizeDiagnosticFileKey(uriOrPath: string): string {
  let fsPath = uriOrPath
  if (uriOrPath.startsWith('file://')) {
    try {
      fsPath = fileURLToPath(uriOrPath)
    } catch {
      fsPath = uriOrPath.replace(/^file:\/\/\/?/, '')
    }
  }
  const resolved = resolve(fsPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function serializeDiagnosticIdentity(diag: Diagnostic): string {
  return jsonStringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source ?? null,
    code: diag.code ?? null,
  })
}

/**
 * Registers newly published diagnostics from `serverName` for next-turn attachment
 * delivery.
 */
export function registerPendingLspDiagnostic(
  entry: PendingLspDiagnostic,
): void {
  const existing = pendingDiagnostics.get(entry.serverName)
  if (!existing) {
    pendingDiagnostics.set(entry.serverName, {
      serverName: entry.serverName,
      files: [...entry.files],
    })
    return
  }

  // Replace earlier snapshot for the same file URI from the same server
  const byFileKey = new Map<string, DiagnosticFile>()
  for (const f of existing.files) {
    byFileKey.set(normalizeDiagnosticFileKey(f.uri), f)
  }
  for (const f of entry.files) {
    byFileKey.set(normalizeDiagnosticFileKey(f.uri), f)
  }
  existing.files = Array.from(byFileKey.values())
}

export const registerPendingLSPDiagnostic = registerPendingLspDiagnostic

/**
 * Drains, deduplicates, sorts (`Error` -> `Warning` -> `Info` -> `Hint`), and
 * caps (`10`/file, `30`/batch) pending LSP diagnostics across all servers.
 */
export function checkForLspDiagnostics(): Array<{
  serverName: string
  files: DiagnosticFile[]
}> {
  if (pendingDiagnostics.size === 0) {
    return []
  }

  const serverNames = new Set<string>()
  const mergedByFile = new Map<
    string,
    { displayUri: string; seenInBatch: Set<string>; items: Diagnostic[] }
  >()

  for (const [srvName, batch] of pendingDiagnostics.entries()) {
    serverNames.add(srvName)
    for (const fileEntry of batch.files) {
      const fileKey = normalizeDiagnosticFileKey(fileEntry.uri)
      const previouslyDelivered = deliveredDiagnostics.get(fileKey)
      let bucket = mergedByFile.get(fileKey)
      if (!bucket) {
        bucket = {
          displayUri: fileEntry.uri,
          seenInBatch: new Set<string>(),
          items: [],
        }
        mergedByFile.set(fileKey, bucket)
      }

      for (const diag of fileEntry.diagnostics) {
        const id = serializeDiagnosticIdentity(diag)
        if (bucket.seenInBatch.has(id) || previouslyDelivered?.has(id)) {
          continue
        }
        bucket.seenInBatch.add(id)
        bucket.items.push(diag)
      }
    }
  }

  pendingDiagnostics.clear()

  const outputFiles: DiagnosticFile[] = []
  let totalIncluded = 0

  for (const [fileKey, bucket] of mergedByFile.entries()) {
    if (bucket.items.length === 0 || totalIncluded >= MAX_TOTAL_DIAGNOSTICS) {
      continue
    }
    bucket.items.sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
    )

    const remainingTotal = MAX_TOTAL_DIAGNOSTICS - totalIncluded
    const sliced = bucket.items.slice(
      0,
      Math.min(MAX_DIAGNOSTICS_PER_FILE, remainingTotal),
    )
    if (sliced.length === 0) {
      continue
    }

    let deliveredSet = deliveredDiagnostics.get(fileKey)
    if (!deliveredSet) {
      deliveredSet = new Set<string>()
    }
    for (const diag of sliced) {
      deliveredSet.add(serializeDiagnosticIdentity(diag))
    }
    deliveredDiagnostics.set(fileKey, deliveredSet)

    outputFiles.push({
      uri: bucket.displayUri,
      diagnostics: sliced,
    })
    totalIncluded += sliced.length
  }

  if (outputFiles.length === 0) {
    return []
  }

  return [
    {
      serverName: Array.from(serverNames).join(', '),
      files: outputFiles,
    },
  ]
}

export const checkForLSPDiagnostics = checkForLspDiagnostics

/**
 * Clears pending unsent diagnostics without resetting delivered LRU history.
 */
export function clearAllLspDiagnostics(): void {
  pendingDiagnostics.clear()
}

export const clearAllLSPDiagnostics = clearAllLspDiagnostics

/**
 * Clears delivered diagnostic history for `uriOrPath` when `Edit` or `Write`
 * modifies a file so re-occurring diagnostics on the edited file are surfaced.
 */
export function clearDeliveredDiagnosticsForFile(uriOrPath: string): void {
  deliveredDiagnostics.delete(normalizeDiagnosticFileKey(uriOrPath))
}

/**
 * Resets both pending and delivered diagnostic state (used by `/clear` and tests).
 */
export function resetAllLspDiagnosticState(): void {
  pendingDiagnostics.clear()
  deliveredDiagnostics.clear()
}

export const resetAllLSPDiagnosticState = resetAllLspDiagnosticState

/**
 * Returns the number of servers currently holding unsent diagnostics.
 */
export function getPendingLspDiagnosticCount(): number {
  return pendingDiagnostics.size
}
