import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  resetStateForTests,
  setCwdState,
  setProjectRoot,
} from '../../src/bootstrap/state.js'
import {
  checkForLspDiagnostics,
  clearDeliveredDiagnosticsForFile,
  MAX_DIAGNOSTICS_PER_FILE,
  MAX_TOTAL_DIAGNOSTICS,
  registerPendingLspDiagnostic,
  resetAllLspDiagnosticState,
} from '../../src/services/lsp/lsp_diagnostic_registry.js'
import {
  getLspServerManager,
  initializeLspServerManager,
  isLspConnected,
  shutdownLspServerManager,
} from '../../src/services/lsp/manager.js'
import { FileEditTool } from '../../src/tools/file_edit_tool/file_edit_tool.js'
import { FileReadTool } from '../../src/tools/file_read_tool/file_read_tool.js'
import { LSPTool } from '../../src/tools/lsp_tool/lsp_tool.js'
import type { ToolUseContext } from '../../src/tool.js'
import { getAttachments } from '../../src/utilities/attachments.js'
import { normalizeMessagesForApi } from '../../src/utilities/messages.js'
import { createFileStateCache } from '../../src/utilities/query_helpers.js'

/**
 * Self-contained mock LSP server speaking standard `Content-Length` framed
 * JSON-RPC 2.0 over stdio, supporting all 9 `LSPTool` methods, `-32801`
 * `ContentModified` retry simulation, crash recovery testing, and automatic
 * `textDocument/publishDiagnostics` push on `didOpen` / `didSave`.
 */
const MOCK_LSP_SERVER_SCRIPT = `
const fs = require('fs');
const stateFile = process.env.MOCK_LSP_STATE_FILE;
let buf = Buffer.alloc(0);
let modifiedRetried = false;

function send(msg) {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}

function recordEvent(ev) {
  if (!stateFile) return;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  list.push(ev);
  fs.writeFileSync(stateFile, JSON.stringify(list));
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    recordEvent({ type: 'initialize', pid: process.pid });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          implementationProvider: true,
          callHierarchyProvider: true,
        },
      },
    });
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
  if (
    msg.method === 'textDocument/didOpen' ||
    msg.method === 'textDocument/didChange' ||
    msg.method === 'textDocument/didSave'
  ) {
    const uri = msg.params.textDocument.uri;
    const text =
      msg.params.textDocument.text ||
      (msg.params.contentChanges && msg.params.contentChanges[0] && msg.params.contentChanges[0].text) ||
      msg.params.text ||
      '';
    recordEvent({ type: msg.method, uri });
    if (text.includes('TRIGGER_DIAG_ERROR')) {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 1, character: 6 }, end: { line: 1, character: 14 } },
              severity: 1,
              source: 'ts',
              code: 2322,
              message: "Type 'string' is not assignable to type 'number'.",
            },
          ],
        },
      });
    }
    return;
  }
  if (msg.method === 'custom/crashNow') {
    process.exit(1);
  }
  if (msg.method === 'textDocument/definition') {
    const uri = msg.params.textDocument.uri;
    const pos = msg.params.position;
    recordEvent({ type: 'definition', position: pos });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          uri,
          range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
        },
      ],
    });
    return;
  }
  if (msg.method === 'textDocument/references') {
    // Simulate a single transient -32801 ContentModified error to verify retry
    if (!modifiedRetried) {
      modifiedRetried = true;
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32801, message: 'ContentModified' },
      });
      return;
    }
    const uri = msg.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } },
        { uri, range: { start: { line: 2, character: 9 }, end: { line: 2, character: 14 } } },
      ],
    });
    return;
  }
  if (msg.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        contents: { kind: 'markdown', value: 'function greet(name: string): string' },
        range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
      },
    });
    return;
  }
  if (msg.method === 'textDocument/documentSymbol') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          name: 'greet',
          detail: '(name: string): string',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
        },
      ],
    });
    return;
  }
  if (msg.method === 'workspace/symbol') {
    const uri = process.env.MOCK_DEFAULT_URI;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          name: 'greet',
          kind: 12,
          location: {
            uri,
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
          },
        },
      ],
    });
    return;
  }
  if (msg.method === 'textDocument/implementation') {
    const uri = msg.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          targetUri: uri,
          targetRange: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          targetSelectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
        },
      ],
    });
    return;
  }
  if (msg.method === 'textDocument/prepareCallHierarchy') {
    const uri = msg.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          name: 'greet',
          kind: 12,
          uri,
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
        },
      ],
    });
    return;
  }
  if (msg.method === 'callHierarchy/incomingCalls') {
    const item = msg.params.item;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          from: { ...item, name: 'mainCaller' },
          fromRanges: [{ start: { line: 2, character: 2 }, end: { line: 2, character: 7 } }],
        },
      ],
    });
    return;
  }
  if (msg.method === 'callHierarchy/outgoingCalls') {
    const item = msg.params.item;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          to: { ...item, name: 'helperCallee' },
          fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 14 } }],
        },
      ],
    });
    return;
  }
}

process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep === -1) break;
    const header = buf.subarray(0, sep).toString('ascii');
    const m = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!m) break;
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) break;
    const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.subarray(sep + 4 + len);
    handleMessage(JSON.parse(body));
  }
});
`

describe('Phase 8.4: LSP JSON-RPC client, all 9 LSPTool operations, crash recovery, and passive diagnostics', () => {
  let tempRoot: string
  let repoDir: string
  let serverScriptPath: string
  let stateFilePath: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-phase8-lsp-'))
    repoDir = join(tempRoot, 'workspace')
    mkdirSync(repoDir, { recursive: true })
    serverScriptPath = join(tempRoot, 'mock_lsp_server.cjs')
    stateFilePath = join(tempRoot, 'lsp_events.json')
    writeFileSync(serverScriptPath, MOCK_LSP_SERVER_SCRIPT, 'utf8')

    resetStateForTests()
    setCwdState(repoDir)
    setProjectRoot(repoDir)
    resetAllLspDiagnosticState()
  })

  afterEach(async () => {
    await shutdownLspServerManager()
    resetAllLspDiagnosticState()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('lazily starts server on first file operation, executes all 9 LSPTool operations (with -32801 retry), and recovers from crashes', async () => {
    const sampleTs = join(repoDir, 'sample.ts')
    writeFileSync(
      sampleTs,
      [
        'export function greet(name: string): string {',
        '  return `Hello ${name}`',
        '}',
        'greet("world")',
      ].join('\n'),
      'utf8',
    )

    await initializeLspServerManager({
      mockTs: {
        command: process.execPath,
        args: [serverScriptPath],
        extensionToLanguage: { '.ts': 'typescript' },
        env: {
          MOCK_LSP_STATE_FILE: stateFilePath,
          MOCK_DEFAULT_URI: pathToFileURL(sampleTs).href,
        },
        maxRestarts: 2,
        scope: 'dynamic',
        source: 'test',
      },
    })

    expect(isLspConnected()).toBe(true)
    const manager = getLspServerManager()!
    const srv = manager.getServerForFile(sampleTs)!
    // Lazy startup: server is still 'stopped' before any file operation
    expect(srv.state).toBe('stopped')

    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      readFileState: createFileStateCache(),
    }

    // 1. goToDefinition (1-based line=4, character=1 -> sent as 0-based {line:3, character:0})
    const defRes = await LSPTool.call(
      { operation: 'goToDefinition', filePath: sampleTs, line: 4, character: 1 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(srv.state).toBe('running')
    expect(defRes.data.result).toContain('sample.ts:1:17')

    // 2. findReferences (exercises -32801 ContentModified retry transparently!)
    const refRes = await LSPTool.call(
      { operation: 'findReferences', filePath: sampleTs, line: 1, character: 17 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(refRes.data.resultCount).toBe(2)

    // 3. hover
    const hoverRes = await LSPTool.call(
      { operation: 'hover', filePath: sampleTs, line: 1, character: 17 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(hoverRes.data.result).toContain('function greet(name: string): string')

    // 4. documentSymbol
    const docSymRes = await LSPTool.call(
      { operation: 'documentSymbol', filePath: sampleTs, line: 1, character: 1 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(docSymRes.data.result).toContain('Function greet')

    // 5. workspaceSymbol
    const wsSymRes = await LSPTool.call(
      { operation: 'workspaceSymbol', filePath: sampleTs, line: 1, character: 1 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(wsSymRes.data.result).toContain('Function greet')

    // 6. goToImplementation
    const implRes = await LSPTool.call(
      { operation: 'goToImplementation', filePath: sampleTs, line: 1, character: 17 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(implRes.data.resultCount).toBe(1)

    // 7. prepareCallHierarchy
    const prepRes = await LSPTool.call(
      { operation: 'prepareCallHierarchy', filePath: sampleTs, line: 1, character: 17 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(prepRes.data.result).toContain('greet')

    // 8. incomingCalls
    const inCallsRes = await LSPTool.call(
      { operation: 'incomingCalls', filePath: sampleTs, line: 1, character: 17 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(inCallsRes.data.result).toContain('mainCaller')

    // 9. outgoingCalls
    const outCallsRes = await LSPTool.call(
      { operation: 'outgoingCalls', filePath: sampleTs, line: 1, character: 17 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(outCallsRes.data.result).toContain('helperCallee')

    // Crash recovery: force child exit(1) and verify auto-restart on next request
    srv.client.sendNotification('custom/crashNow', {})
    const waitDeadline = Date.now() + 3_000
    while (srv.restartCount < 1 && Date.now() < waitDeadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    const postCrashHover = await LSPTool.call(
      { operation: 'hover', filePath: sampleTs, line: 1, character: 17 },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(postCrashHover.data.result).toContain('greet')
  }, 20_000)

  test('enforces 10/file & 30/batch caps, deduplicates passive publishDiagnostics, and re-surfaces after FileEditTool clears file history', async () => {
    // 1. Unit cap & dedup verification
    const noisyFiles = Array.from({ length: 5 }, (_, fileIdx) => ({
      uri: join(repoDir, `file_${fileIdx}.ts`),
      diagnostics: Array.from({ length: 15 }, (__, diagIdx) => ({
        message: `Diag ${diagIdx}`,
        severity: (diagIdx % 2 === 0 ? 'Warning' : 'Error') as 'Error' | 'Warning',
        range: {
          start: { line: diagIdx, character: 0 },
          end: { line: diagIdx, character: 5 },
        },
      })),
    }))
    registerPendingLspDiagnostic({ serverName: 'ts', files: noisyFiles })
    const drained = checkForLspDiagnostics()
    const totalCount = drained.reduce(
      (sum, b) => sum + b.files.reduce((s2, f) => s2 + f.diagnostics.length, 0),
      0,
    )
    expect(totalCount).toBe(MAX_TOTAL_DIAGNOSTICS) // capped at 30
    for (const f of drained[0]!.files) {
      expect(f.diagnostics.length).toBeLessThanOrEqual(MAX_DIAGNOSTICS_PER_FILE) // capped at 10
      // Errors sorted ahead of Warnings
      expect(f.diagnostics[0]?.severity).toBe('Error')
    }

    // Drain remaining 45 undelivered diagnostics across 2 more capped batches (30 + 15),
    // then verify re-registering identical diagnostics is completely suppressed by deliveredDiagnostics LRU!
    registerPendingLspDiagnostic({ serverName: 'ts', files: noisyFiles })
    expect(
      checkForLspDiagnostics().reduce(
        (sum, b) => sum + b.files.reduce((s2, f) => s2 + f.diagnostics.length, 0),
        0,
      ),
    ).toBe(30)
    registerPendingLspDiagnostic({ serverName: 'ts', files: noisyFiles })
    expect(
      checkForLspDiagnostics().reduce(
        (sum, b) => sum + b.files.reduce((s2, f) => s2 + f.diagnostics.length, 0),
        0,
      ),
    ).toBe(15)
    registerPendingLspDiagnostic({ serverName: 'ts', files: noisyFiles })
    expect(checkForLspDiagnostics()).toEqual([])

    // Clearing a single file allows its diagnostics (capped at 10/file) to surface again
    clearDeliveredDiagnosticsForFile(noisyFiles[0]!.uri)
    registerPendingLspDiagnostic({
      serverName: 'ts',
      files: [noisyFiles[0]!],
    })
    expect(checkForLspDiagnostics()[0]?.files.length).toBe(1)

    resetAllLspDiagnosticState()

    // 2. End-to-end save-time publishDiagnostics via FileEditTool -> getAttachments -> <new-diagnostics>
    const buggyFile = join(repoDir, 'buggy.ts')
    writeFileSync(buggyFile, 'export const count: number = 1;\n', 'utf8')

    await initializeLspServerManager({
      mockTs: {
        command: process.execPath,
        args: [serverScriptPath],
        extensionToLanguage: { '.ts': 'typescript' },
        scope: 'dynamic',
        source: 'test',
      },
    })

    const readFileState = createFileStateCache()
    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      readFileState,
    }

    // Open file in LSP first so server is running, then read & edit via FileEditTool
    await getLspServerManager()!.openFile(
      buggyFile,
      'export const count: number = 1;\n',
    )
    await FileReadTool.call(
      { file_path: buggyFile },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    await FileEditTool.call(
      {
        file_path: buggyFile,
        old_string: 'export const count: number = 1;',
        new_string: 'export const count: number = 1;\n// TRIGGER_DIAG_ERROR',
        replace_all: false,
      },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )

    // Wait briefly for async didSave -> publishDiagnostics notification
    const deadline = Date.now() + 3_000
    let attachments = await getAttachments(null, ctx)
    while (
      !attachments.some(a => a.type === 'diagnostics') &&
      Date.now() < deadline
    ) {
      await new Promise(r => setTimeout(r, 80))
      attachments = await getAttachments(null, ctx)
    }

    const diagAttachment = attachments.find(a => a.type === 'diagnostics')
    expect(diagAttachment).toBeDefined()

    const normalized = normalizeMessagesForApi([
      {
        type: 'attachment',
        attachment: diagAttachment!,
        uuid: '00000000-0000-4000-8000-000000000001',
        timestamp: new Date().toISOString(),
      },
    ])
    const serialized = JSON.stringify(normalized)
    expect(serialized).toContain('<new-diagnostics>')
    expect(serialized).toContain("Type 'string' is not assignable to type 'number'.")
  })
})
