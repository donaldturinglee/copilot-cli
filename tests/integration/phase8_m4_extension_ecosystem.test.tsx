import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { UUID } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setCwdState,
  setInlinePlugins,
  setProjectRoot,
  setSessionTrustAccepted,
} from '../../src/bootstrap/state.js'
import { clearCommandsCache, getCommands } from '../../src/commands.js'
import { QueryEngine } from '../../src/query_engine.js'
import { EMPTY_USAGE } from '../../src/services/api/empty_usage.js'
import { resetAllLspDiagnosticState } from '../../src/services/lsp/lsp_diagnostic_registry.js'
import {
  initializeLspServerManager,
  shutdownLspServerManager,
} from '../../src/services/lsp/manager.js'
import {
  cleanupAllMcpClients,
  getMcpToolsCommandsAndResources,
} from '../../src/services/mcp/client.js'
import { getAllMcpConfigs } from '../../src/services/mcp/config.js'
import { clearSkillCaches } from '../../src/skills/load_skills_dir.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import { assembleToolPool } from '../../src/tools.js'
import type { AssistantMessage } from '../../src/types/message.js'
import { getEmptyToolPermissionContext } from '../../src/types/permissions.js'
import { randomUUID } from '../../src/utilities/crypto.js'
import {
  clearAllPluginCaches,
  refreshActivePlugins,
} from '../../src/utilities/plugins/refresh.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

const E2E_MCP_SERVER_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'plugin-mcp', version: '1.0.0' },
      },
    }) + '\\n');
  } else if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [{
          name: 'lookup_ticket',
          description: 'Looks up issue ticket metadata',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        }],
      },
    }) + '\\n');
  } else if (req.method === 'tools/call') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [{ type: 'text', text: 'TICKET_FOUND:' + req.params.arguments.id }],
      },
    }) + '\\n');
  }
});
`

const E2E_LSP_SERVER_SCRIPT = `
let buf = Buffer.alloc(0);
function send(msg) {
  const b = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n');
  process.stdout.write(b);
}
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep === -1) break;
    const m = buf.subarray(0, sep).toString('ascii').match(/Content-Length:\\s*(\\d+)/i);
    if (!m) break;
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) break;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8'));
    buf = buf.subarray(sep + 4 + len);
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { capabilities: { textDocumentSync: 1, definitionProvider: true } },
      });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      process.exit(0);
    } else if (msg.method === 'textDocument/definition') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: [{
          uri: msg.params.textDocument.uri,
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
        }],
      });
    } else if (msg.method === 'textDocument/didSave') {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: msg.params.textDocument.uri,
          diagnostics: [{
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
            severity: 1,
            source: 'e2e-lsp',
            message: 'Missing return type annotation on updated handler',
          }],
        },
      });
    }
  }
});
`

function makeAssistantResponse(
  blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >,
  stopReason: 'tool_use' | 'end_turn',
): AssistantMessage {
  const uuid = randomUUID() as UUID
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    requestId: 'req_m4',
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { ...EMPTY_USAGE } as BetaMessage['usage'],
    } as BetaMessage,
  }
}

describe('Phase 8 M4 Milestone Integration — Unified MCP + Skills + Plugins + LSP Ecosystem', () => {
  let tempRoot: string
  let configDir: string
  let repoDir: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-phase8-m4-'))
    configDir = join(tempRoot, 'copilot-config')
    repoDir = join(tempRoot, 'workspace')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })

    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir

    resetStateForTests()
    setCwdState(repoDir)
    setProjectRoot(repoDir)
    setSessionTrustAccepted(true)
    resetSettingsCache()
    clearSkillCaches()
    clearCommandsCache()
    clearAllPluginCaches()
    resetAllLspDiagnosticState()
  })

  afterEach(async () => {
    setInlinePlugins([])
    await cleanupAllMcpClients()
    await shutdownLspServerManager()
    resetAllLspDiagnosticState()
    clearSkillCaches()
    clearCommandsCache()
    clearAllPluginCaches()
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('executes multi-turn agent workflow combining --plugin-dir MCP + LSP, project SkillTool, Read/Edit, and passive save-time LSP diagnostics', async () => {
    // 1. Create workspace source file and project skill
    const srcFile = join(repoDir, 'service.ts')
    writeFileSync(
      srcFile,
      'export const SERVICE = "v1";\nexport function run() { return SERVICE; }\n',
      'utf8',
    )
    const projSkillDir = join(repoDir, '.copilot', 'skills', 'ticket-workflow')
    mkdirSync(projSkillDir, { recursive: true })
    writeFileSync(
      join(projSkillDir, 'SKILL.md'),
      `---\ndescription: Ticket triage skill\n---\nFollow strict triage steps for $ARGUMENTS.`,
      'utf8',
    )

    // 2. Create a --plugin-dir extension providing BOTH an MCP server and a .lsp.json server
    const pluginDir = join(tempRoot, 'm4-dev-plugin')
    mkdirSync(join(pluginDir, '.copilot-plugin'), { recursive: true })
    const mcpScriptPath = join(pluginDir, 'mcp_server.cjs')
    const lspScriptPath = join(pluginDir, 'lsp_server.cjs')
    writeFileSync(mcpScriptPath, E2E_MCP_SERVER_SCRIPT, 'utf8')
    writeFileSync(lspScriptPath, E2E_LSP_SERVER_SCRIPT, 'utf8')

    writeFileSync(
      join(pluginDir, '.copilot-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'm4-ext',
        version: '1.0.0',
        description: 'M4 unified MCP + LSP plugin',
      }),
      'utf8',
    )
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          tracker: {
            command: process.execPath,
            args: ['${COPILOT_PLUGIN_ROOT}/mcp_server.cjs'],
          },
        },
      }),
      'utf8',
    )
    writeFileSync(
      join(pluginDir, '.lsp.json'),
      JSON.stringify({
        tsLsp: {
          command: process.execPath,
          args: ['${COPILOT_PLUGIN_ROOT}/lsp_server.cjs'],
          extensionToLanguage: { '.ts': 'typescript' },
        },
      }),
      'utf8',
    )

    // 3. Load plugins, LSP manager, MCP servers, and Skills
    setInlinePlugins([pluginDir])
    const store = createStore<AppState>({
      ...getDefaultAppState(),
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        mode: 'bypassPermissions',
      },
    })

    await refreshActivePlugins(store.setState)
    await initializeLspServerManager()

    const allMcpConfigs = await getAllMcpConfigs({ includeClaudeAi: false })
    const mcpConnected = await getMcpToolsCommandsAndResources(
      allMcpConfigs.servers,
    )
    const mcpToolName = mcpConnected.tools[0]?.name ?? ''
    expect(mcpToolName).toContain('lookup_ticket')

    const commands = await getCommands(repoDir)
    const tools = assembleToolPool(
      store.getState().toolPermissionContext,
      mcpConnected.tools,
    )
    expect(tools.some(t => t.name === 'Skill')).toBe(true)
    expect(tools.some(t => t.name === 'LSP')).toBe(true)
    expect(tools.some(t => t.name === mcpToolName)).toBe(true)

    // 4. Drive QueryEngine through:
    // Turn 1: Call MCP lookup_ticket + Skill(ticket-workflow) + LSP(goToDefinition) + Read(service.ts)
    // Turn 2: Call Edit(service.ts) -> triggers didSave -> LSP publishes diagnostic!
    // Turn 3: Wait briefly so publishDiagnostics arrives before Turn 3's getAttachments, verify model receives <new-diagnostics>!
    let callIndex = 0
    const seenApiMessages: unknown[][] = []

    const engine = new QueryEngine({
      cwd: repoDir,
      tools,
      commands,
      mcpClients: mcpConnected.clients as unknown as readonly import('../../src/types/forward.js').McpServerConnection[],
      canUseTool: async (_t, inp) => ({ behavior: 'allow', updatedInput: inp }),
      getAppState: () => store.getState(),
      setAppState: store.setState,
      deps: {
        uuid: () => randomUUID(),
        now: () => new Date(),
        callModel: async function* (params: { messages: unknown[] }) {
          seenApiMessages.push(params.messages)
          callIndex++
          if (callIndex === 1) {
            yield makeAssistantResponse(
              [
                {
                  type: 'tool_use',
                  id: 'tu_mcp',
                  name: mcpToolName,
                  input: { id: 'ISSUE-42' },
                },
                {
                  type: 'tool_use',
                  id: 'tu_skill',
                  name: 'Skill',
                  input: { skill: 'ticket-workflow', args: 'ISSUE-42' },
                },
                {
                  type: 'tool_use',
                  id: 'tu_lsp',
                  name: 'LSP',
                  input: {
                    operation: 'goToDefinition',
                    filePath: srcFile,
                    line: 2,
                    character: 26,
                  },
                },
                {
                  type: 'tool_use',
                  id: 'tu_read',
                  name: 'Read',
                  input: { file_path: srcFile },
                },
              ],
              'tool_use',
            )
            return
          }
          if (callIndex === 2) {
            yield makeAssistantResponse(
              [
                {
                  type: 'tool_use',
                  id: 'tu_edit',
                  name: 'Edit',
                  input: {
                    file_path: srcFile,
                    old_string: 'export const SERVICE = "v1";',
                    new_string: 'export const SERVICE = "v2";',
                    replace_all: false,
                  },
                },
              ],
              'tool_use',
            )
            return
          }
          if (callIndex === 3) {
            // Allow 120ms for async LSP didSave -> publishDiagnostics if not yet in params.messages,
            // then trigger one final no-op Read to surface the passive diagnostic attachment if needed
            const serializedSoFar = JSON.stringify(params.messages)
            if (!serializedSoFar.includes('<new-diagnostics>')) {
              await new Promise(r => setTimeout(r, 150))
              yield makeAssistantResponse(
                [
                  {
                    type: 'tool_use',
                    id: 'tu_read_2',
                    name: 'Read',
                    input: { file_path: srcFile },
                  },
                ],
                'tool_use',
              )
              return
            }
          }
          yield makeAssistantResponse(
            [{ type: 'text', text: 'Completed ISSUE-42 update with diagnostics reviewed.' }],
            'end_turn',
          )
        },
        microcompact: async (
          msgs: readonly import('../../src/types/message.js').Message[],
        ) => ({ messages: [...msgs] }),
        autocompact: async (
          msgs: readonly import('../../src/types/message.js').Message[],
        ) => ({ messages: [...msgs], wasCompacted: false }),
      } as unknown as import('../../src/query/deps.js').QueryDeps,
    })

    const events: import('../../src/utilities/messages/mappers.js').SdkMessage[] = []
    for await (const ev of engine.submitMessage('Resolve ISSUE-42')) {
      events.push(ev)
    }

    const allPayloads = JSON.stringify(seenApiMessages)
    // MCP tool result delivered to model
    expect(allPayloads).toContain('TICKET_FOUND:ISSUE-42')
    // Skill prompt injected inline into conversation
    expect(allPayloads).toContain('Follow strict triage steps for ISSUE-42.')
    // LSP goToDefinition result delivered to model
    expect(allPayloads).toContain('service.ts:1:14')
    // Passive save-time LSP diagnostic surfaced automatically via <new-diagnostics>
    expect(allPayloads).toContain('<new-diagnostics>')
    expect(allPayloads).toContain(
      'Missing return type annotation on updated handler',
    )

    const finalEvent = events.at(-1)
    expect(finalEvent?.type).toBe('result')
  }, 20_000)
})
