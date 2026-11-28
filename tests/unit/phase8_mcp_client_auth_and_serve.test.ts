import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import type { Server as HttpServer } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setCwdState,
  setProjectRoot,
  setSessionTrustAccepted,
} from '../../src/bootstrap/state.js'
import { createCopilotMcpServer } from '../../src/entrypoints/mcp.js'
import {
  ClaudeAuthProvider,
  getServerKey,
  wrapFetchWithStepUpDetection,
} from '../../src/services/mcp/auth.js'
import {
  gateChannelServer,
  parseChannelEntry,
} from '../../src/services/mcp/channel_allowlist.js'
import {
  shortRequestId,
  tryParsePermissionReply,
} from '../../src/services/mcp/channel_permissions.js'
import {
  cleanupAllMcpClients,
  connectToServer,
  fetchResourcesForClient,
  fetchToolsForClient,
} from '../../src/services/mcp/client.js'
import {
  addMcpConfig,
  dedupClaudeAiMcpServers,
  dedupPluginMcpServers,
  getAllMcpConfigs,
  isMcpServerAllowedByPolicy,
  parseMcpConfigsFromCli,
  removeMcpConfig,
} from '../../src/services/mcp/config.js'
import {
  expandEnvVarsInConfig,
  expandEnvVarsInString,
} from '../../src/services/mcp/env_expansion.js'
import { createLinkedTransportPair } from '../../src/services/mcp/in_process_transport.js'
import { performCrossAppAccess } from '../../src/services/mcp/xaa.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import { ListMcpResourcesTool } from '../../src/tools/list_mcp_resources_tool/list_mcp_resources_tool.js'
import { isMcpAuthTool } from '../../src/tools/mcp_auth_tool/mcp_auth_tool.js'
import { ReadMcpResourceTool } from '../../src/tools/read_mcp_resource_tool/read_mcp_resource_tool.js'
import type { ToolUseContext } from '../../src/tool.js'
import { validateElicitationInput } from '../../src/utilities/mcp/elicitation_validation.js'
import { getMcpInstructionsDelta } from '../../src/utilities/mcp_instructions_delta.js'
import { saveMcpOutput } from '../../src/utilities/mcp_output_storage.js'
import { createFileStateCache } from '../../src/utilities/query_helpers.js'
import { updateSettingsForSource } from '../../src/utilities/settings/settings.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

const MOCK_STDIO_MCP_SERVER_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

rl.on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'mock-stdio-mcp', version: '1.0.0' },
        instructions: 'Use mock_echo for echoing strings.',
      },
    });
    return;
  }
  if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'mock_echo',
            description: 'Echoes text back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
    return;
  }
  if (req.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [{ type: 'text', text: 'ECHO:' + (req.params.arguments?.text ?? '') }],
      },
    });
    return;
  }
  if (req.method === 'resources/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        resources: [
          { uri: 'memo://welcome', name: 'Welcome Memo', mimeType: 'text/plain' },
        ],
      },
    });
    return;
  }
  if (req.method === 'resources/read') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        contents: [
          { uri: req.params.uri, mimeType: 'text/plain', text: 'Hello from MCP Resource!' },
        ],
      },
    });
    return;
  }
});
`

describe('Phase 8.1: MCP client, transports, scope merging, OAuth/XAA auth, Elicitation/Channels, and mcp serve', () => {
  let tempRoot: string
  let configDir: string
  let repoDir: string
  let savedConfigDir: string | undefined
  let activeHttpServers: HttpServer[] = []

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-phase8-mcp-'))
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
    activeHttpServers = []
  })

  afterEach(async () => {
    await cleanupAllMcpClients()
    for (const srv of activeHttpServers) {
      await new Promise<void>(resolve => srv.close(() => resolve()))
    }
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('expands ${VAR} / ${VAR:-default}, merges scopes, deduplicates by signature, and enforces policy allow/deny rules', async () => {
    const strRes = expandEnvVarsInString(
      'https://${API_HOST:-localhost:8080}/mcp/${MISSING_TOKEN}',
      { API_HOST: 'mcp.internal' },
    )
    expect(strRes.expanded).toBe('https://mcp.internal/mcp/${MISSING_TOKEN}')
    expect(strRes.missingVars).toEqual(['MISSING_TOKEN'])

    const cfgRes = expandEnvVarsInConfig(
      {
        type: 'http',
        url: 'https://${HOST:-127.0.0.1}/v1',
        headers: { Authorization: 'Bearer ${TOKEN:-dev-tok}' },
        headersHelper: 'echo ${UNTOUCHED_IN_HELPER}',
      },
      {},
    )
    expect(cfgRes.expanded.url).toBe('https://127.0.0.1/v1')
    expect(cfgRes.expanded.headers?.Authorization).toBe('Bearer dev-tok')
    expect(cfgRes.expanded.headersHelper).toBe('echo ${UNTOUCHED_IN_HELPER}')

    // Add user & local MCP servers and verify local overrides user
    addMcpConfig(
      'sharedSrv',
      { type: 'stdio', command: 'node', args: ['user.js'] },
      'user',
    )
    addMcpConfig(
      'sharedSrv',
      { type: 'stdio', command: 'node', args: ['local.js'] },
      'local',
    )

    const merged = await getAllMcpConfigs({ includeClaudeAi: false })
    const shared = merged.servers.sharedSrv
    expect(shared?.scope).toBe('local')
    if (shared && (!shared.type || shared.type === 'stdio')) {
      expect(shared.args).toEqual(['local.js'])
    }

    // Content-signature deduplication suppresses duplicate plugin & claude.ai servers
    const dedupedPlugins = dedupPluginMcpServers(
      {
        'plugin:kit:dup': {
          type: 'stdio',
          command: 'node',
          args: ['local.js'],
          scope: 'dynamic',
        },
        'plugin:kit:unique': {
          type: 'http',
          url: 'https://unique.example.com/mcp/',
          scope: 'dynamic',
        },
      },
      merged.servers,
    )
    expect(dedupedPlugins.servers['plugin:kit:dup']).toBeUndefined()
    expect(dedupedPlugins.servers['plugin:kit:unique']).toBeDefined()
    expect(dedupedPlugins.suppressed).toEqual([
      { name: 'plugin:kit:dup', duplicateOf: 'sharedSrv' },
    ])

    const dedupedClaudeAi = dedupClaudeAiMcpServers(
      {
        'claude.ai Dup': {
          type: 'claudeai-proxy',
          id: '1',
          url: 'https://unique.example.com/mcp',
          scope: 'claudeai',
        },
      },
      dedupedPlugins.servers,
    )
    expect(Object.keys(dedupedClaudeAi)).toEqual([])

    // Policy deniedMcpServers always wins over allowedMcpServers
    updateSettingsForSource('userSettings', {
      allowedMcpServers: [{ serverUrl: 'https://*.corp.internal/*' }],
      deniedMcpServers: [{ serverName: 'blocked-srv' }],
    })
    expect(
      isMcpServerAllowedByPolicy('allowed-srv', {
        type: 'http',
        url: 'https://mcp.corp.internal/v1',
      }),
    ).toBe(true)
    expect(
      isMcpServerAllowedByPolicy('blocked-srv', {
        type: 'http',
        url: 'https://mcp.corp.internal/v1',
      }),
    ).toBe(false)
    expect(
      isMcpServerAllowedByPolicy('external-srv', {
        type: 'http',
        url: 'https://evil.example.org/v1',
      }),
    ).toBe(false)

    expect(removeMcpConfig('sharedSrv', 'local').removed).toBe(true)
    expect(removeMcpConfig('sharedSrv', 'user').removed).toBe(true)
  })

  test('connects to stdio MCP server, executes dynamic MCPTool, lists/reads resources, and computes instructions delta', async () => {
    const serverScript = join(tempRoot, 'mock_stdio_mcp.cjs')
    writeFileSync(serverScript, MOCK_STDIO_MCP_SERVER_SCRIPT, 'utf8')

    const parsedCli = parseMcpConfigsFromCli([
      JSON.stringify({
        mcpServers: {
          demoStdio: {
            command: process.execPath,
            args: [serverScript],
          },
        },
      }),
    ])
    const cfg = parsedCli.servers.demoStdio!
    const conn = await connectToServer('demoStdio', cfg)
    expect(conn.type).toBe('connected')
    if (conn.type !== 'connected') throw new Error('expected connected')

    const tools = await fetchToolsForClient(conn)
    expect(tools.map(t => t.name)).toEqual(['mcp__demoStdio__mock_echo'])

    const store = createStore<AppState>({
      ...getDefaultAppState(),
      mcp: {
        clients: [conn],
        tools: tools as unknown as AppState['mcp']['tools'],
        commands: [],
        resources: {},
        pluginReconnectKey: 0,
      },
    })
    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      readFileState: createFileStateCache(),
      getAppState: () => store.getState(),
      setAppState: store.setState,
      options: {
        mcpClients: [conn],
      },
    }

    // Call dynamic MCPTool
    const echoTool = tools[0]!
    const toolRes = await echoTool.call(
      { text: 'hello-mcp' },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: { text: 'hello-mcp' } }),
      undefined,
    )
    const block = echoTool.mapToolResultToToolResultBlockParam(
      toolRes.data,
      'tu_1',
    )
    expect(JSON.stringify(block.content)).toContain('ECHO:hello-mcp')

    // ListMcpResourcesTool & ReadMcpResourceTool
    const resources = await fetchResourcesForClient(conn)
    expect(resources.length).toBe(1)

    const listRes = await ListMcpResourcesTool.call(
      { server: 'demoStdio' },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(listRes.data[0]?.uri).toBe('memo://welcome')

    const readRes = await ReadMcpResourceTool.call(
      { server: 'demoStdio', uri: 'memo://welcome' },
      ctx,
      async () => ({ behavior: 'allow', updatedInput: {} }),
      undefined,
    )
    expect(readRes.data.contents[0]?.text).toBe('Hello from MCP Resource!')

    // Instructions delta attachment helper
    const delta = getMcpInstructionsDelta([conn], [])
    expect(delta).toEqual([
      {
        serverName: 'demoStdio',
        instructions: 'Use mock_echo for echoing strings.',
      },
    ])

    // Oversized JSON output schema spilling
    const hugeArray = Array.from({ length: 200 }, (_, idx) => ({
      id: idx,
      payload: 'x'.repeat(120),
    }))
    const spilled = saveMcpOutput(JSON.stringify(hugeArray), 'tu_oversized_1')
    expect(spilled.formattedMessage).toContain('Inferred JSON schema:')
    expect(spilled.filepath).toBeTruthy()
  })

  test('copilot mcp serve self-test over InProcessTransport lists and invokes built-in Read and Glob tools', async () => {
    const sampleFile = join(repoDir, 'hello_serve.txt')
    writeFileSync(sampleFile, 'Line 1 from mcp serve\nLine 2\n', 'utf8')

    const [clientTransport, serverTransport] = createLinkedTransportPair()
    const mcpServer = createCopilotMcpServer({ directory: repoDir })
    await mcpServer.connect(serverTransport)

    const mcpClient = new Client(
      { name: 'self-test-client', version: '1.0.0' },
      { capabilities: {} },
    )
    await mcpClient.connect(clientTransport)

    try {
      const listed = await mcpClient.request(
        { method: 'tools/list', params: {} },
        ListToolsResultSchema,
      )
      const names = listed.tools.map(t => t.name)
      expect(names).toContain('Read')
      expect(names).toContain('Glob')

      const callRes = await mcpClient.request(
        {
          method: 'tools/call',
          params: {
            name: 'Read',
            arguments: { file_path: sampleFile },
          },
        },
        CallToolResultSchema,
      )
      expect(callRes.isError).toBe(false)
      expect(JSON.stringify(callRes.content)).toContain('Line 1 from mcp serve')
    } finally {
      await mcpClient.close()
      await mcpServer.close()
    }
  })

  test('handles OAuth PKCE discovery cap, 403 step-up detection, XAA 4-step RFC 8693/7523 exchange, Elicitation validation, and Channels gating', async () => {
    // 1. OAuth PKCE ClaudeAuthProvider 4KB discovery state cap & step-up wrapper
    const serverCfg = { type: 'http' as const, url: 'https://mcp.acme.test/v1' }
    expect(getServerKey('acme', serverCfg)).toMatch(/^acme\|[0-9a-f]{16}$/)

    const provider = new ClaudeAuthProvider('acme', serverCfg, {
      redirectPort: 3118,
    })
    provider.saveCodeVerifier('pkce_verifier_12345')
    expect(provider.codeVerifier()).toBe('pkce_verifier_12345')

    // Oversized (>4KB) discovery metadata is stripped down to compact URLs
    provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.acme.test',
      authorizationServerMetadata: {
        issuer: 'https://auth.acme.test',
        authorization_endpoint: 'https://auth.acme.test/authorize',
        token_endpoint: 'https://auth.acme.test/token',
        response_types_supported: ['code'],
        padding: 'A'.repeat(5_000),
      } as unknown as Parameters<ClaudeAuthProvider['saveDiscoveryState']>[0]['authorizationServerMetadata'],
    })
    expect(provider.discoveryState()?.authorizationServerUrl).toBe(
      'https://auth.acme.test',
    )

    const wrappedFetch = wrapFetchWithStepUpDetection(
      async () =>
        new Response('Forbidden', {
          status: 403,
          headers: {
            'WWW-Authenticate':
              'Bearer error="insufficient_scope", scope="mcp:tools mcp:admin"',
          },
        }),
      provider,
    )
    const stepUpResp = await wrappedFetch('https://mcp.acme.test/v1')
    expect(stepUpResp.status).toBe(403)
    expect(isMcpAuthTool('mcp__acme__authenticate')).toBe(true)

    // 2. XAA 4-step RFC 8693 + RFC 7523 token exchange against mock endpoints
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('.well-known/oauth-protected-resource')) {
        return new Response(
          JSON.stringify({
            resource: 'https://mcp.acme.test/v1',
            authorization_servers: ['https://as.acme.test'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.startsWith('https://as.acme.test/.well-known/')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://as.acme.test',
            authorization_endpoint: 'https://as.acme.test/authorize',
            token_endpoint: 'https://as.acme.test/token',
            response_types_supported: ['code'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.startsWith('https://idp.acme.test/.well-known/')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://idp.acme.test',
            authorization_endpoint: 'https://idp.acme.test/authorize',
            token_endpoint: 'https://idp.acme.test/token',
            jwks_uri: 'https://idp.acme.test/jwks.json',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === 'https://idp.acme.test/token') {
        return new Response(
          JSON.stringify({
            access_token: 'id_jag_assertion_jwt',
            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
            token_type: 'N_A',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url === 'https://as.acme.test/token') {
        return new Response(
          JSON.stringify({
            access_token: 'mcp_final_access_token_xyz',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    const xaaTokens = await performCrossAppAccess({
      serverName: 'acme',
      serverUrl: 'https://mcp.acme.test/v1',
      idpIssuer: 'https://idp.acme.test',
      idpClientId: 'idp-client-1',
      idToken: 'oidc_id_token_jwt',
      mcpClientId: 'mcp-client-1',
      fetchFn: mockFetch,
    })
    expect(xaaTokens.access_token).toBe('mcp_final_access_token_xyz')

    // 3. Elicitation form validation & Channel allowlist + shortRequestId
    const validForm = validateElicitationInput(
      { email: 'eng@acme.com', retries: 3 },
      {
        type: 'object',
        required: ['email', 'retries'],
        properties: {
          email: { type: 'string', format: 'email' },
          retries: { type: 'integer', minimum: 1, maximum: 5 },
        },
      },
    )
    expect(validForm.valid).toBe(true)

    const invalidForm = validateElicitationInput(
      { email: 'not-an-email' },
      {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string', format: 'email' } },
      },
    )
    expect(invalidForm.valid).toBe(false)

    const reqCode = shortRequestId('toolu_01ABCXYZ')
    expect(reqCode).toHaveLength(5)
    expect(reqCode).not.toContain('l')
    expect(tryParsePermissionReply(`yes ${reqCode}`)).toEqual({
      approved: true,
      requestId: reqCode,
    })

    const channelEntry = parseChannelEntry('server:pagerduty', true)!
    expect(
      gateChannelServer({
        serverName: 'pagerduty',
        capabilities: { experimental: { 'claude/channel': {} } },
        allowedEntries: [channelEntry],
      }).allowed,
    ).toBe(true)
    expect(
      gateChannelServer({
        serverName: 'unlisted',
        capabilities: { experimental: { 'claude/channel': {} } },
        allowedEntries: [channelEntry],
      }).allowed,
    ).toBe(false)
  })
})
