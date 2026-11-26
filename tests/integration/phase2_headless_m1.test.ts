import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REPO_ROOT = process.cwd()
const CLI_ENTRY = join(REPO_ROOT, 'src', 'entrypoints', 'cli.tsx')

const tempDirs: string[] = []
const activeServers: Array<{ stop: (close?: boolean) => void }> = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function buildSseBody(chunks: string[], model = 'claude-sonnet-4-6'): string {
  const frames: Array<{ event: string; data: unknown }> = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_m1_001',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1200,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    ...chunks.map(text => ({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    })),
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 60 },
      },
    },
    {
      event: 'message_stop',
      data: { type: 'message_stop' },
    },
  ]

  return frames
    .map(f => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
    .join('')
}

afterEach(() => {
  for (const server of activeServers.splice(0)) {
    server.stop(true)
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Phase 2 M1 Milestone — End-to-End Headless `-p` Integration', () => {
  test(
    'copilot -p streams SSE response, prints output, and reports USD cost (--verbose and --output-format json)',
    async () => {
      const threeSentences = [
        'The JavaScript event loop continuously checks the call stack and queues pending callbacks. ',
        'When synchronous code finishes executing, it drains the microtask queue before handling the next macrotask. ',
        'This non-blocking architecture allows single-threaded runtimes to coordinate asynchronous I/O efficiently.',
      ]

      const receivedAuthHeaders: string[] = []
      let receivedStreamRequests = 0

      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname.endsWith('/v1/messages') && req.method === 'POST') {
            const apiKeyHeader = req.headers.get('x-api-key')
            if (apiKeyHeader) {
              receivedAuthHeaders.push(apiKeyHeader)
            }
            const body = (await req.json()) as {
              model?: string
              stream?: boolean
            }
            if (body.stream) {
              receivedStreamRequests++
              return new Response(
                buildSseBody(threeSentences, body.model ?? 'claude-sonnet-4-6'),
                {
                  status: 200,
                  headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'request-id': 'req_m1_sse_1',
                  },
                },
              )
            }
          }
          return new Response('Not found', { status: 404 })
        },
      })
      activeServers.push(server)

      const configDir = makeTempDir('copilot-m1-cfg-')
      const baseEnv = {
        ...process.env,
        NODE_ENV: 'production',
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        ANTHROPIC_API_KEY: 'sk-ant-api03-m1-integration-test-key',
        COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }

      // 1. Default text streaming with --verbose cost reporting
      const procText = Bun.spawn(
        [
          'bun',
          'run',
          CLI_ENTRY,
          '-p',
          'Explain the event loop in three sentences',
          '--verbose',
          '--model',
          'sonnet',
        ],
        {
          cwd: REPO_ROOT,
          env: baseEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdoutText, stderrText, exitCodeText] = await Promise.all([
        new Response(procText.stdout).text(),
        new Response(procText.stderr).text(),
        procText.exited,
      ])

      expect(exitCodeText).toBe(0)
      expect(receivedAuthHeaders[0]).toBe('sk-ant-api03-m1-integration-test-key')
      expect(receivedStreamRequests).toBe(1)
      expect(stdoutText.trim()).toBe(threeSentences.join(''))
      expect(stderrText).toContain('Total cost:')
      expect(stderrText).toContain('claude-sonnet-4-6')

      // 2. --output-format json emits SdkResultMessage with total_cost_usd
      const procJson = Bun.spawn(
        [
          'bun',
          'run',
          CLI_ENTRY,
          '-p',
          'Explain the event loop in three sentences',
          '--output-format',
          'json',
          '--model',
          'sonnet',
        ],
        {
          cwd: REPO_ROOT,
          env: baseEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdoutJson, , exitCodeJson] = await Promise.all([
        new Response(procJson.stdout).text(),
        new Response(procJson.stderr).text(),
        procJson.exited,
      ])

      expect(exitCodeJson).toBe(0)
      const parsed = JSON.parse(stdoutJson) as {
        type: string
        subtype: string
        is_error: boolean
        result: string
        total_cost_usd: number
        modelUsage: Record<string, { costUSD: number; inputTokens: number }>
      }
      expect(parsed.type).toBe('result')
      expect(parsed.subtype).toBe('success')
      expect(parsed.is_error).toBe(false)
      expect(parsed.result).toBe(threeSentences.join(''))
      expect(parsed.total_cost_usd).toBeGreaterThan(0)
      expect(parsed.modelUsage['claude-sonnet-4-6']?.inputTokens).toBe(1200)
    },
    15_000,
  )

  test(
    'recovers cleanly via non-streaming fallback over HTTP when SSE stream drops unexpectedly',
    async () => {
      let streamHits = 0
      let nonStreamHits = 0

      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname.endsWith('/v1/messages') && req.method === 'POST') {
            const body = (await req.json()) as {
              model?: string
              stream?: boolean
            }
            if (body.stream) {
              streamHits++
              // Return empty SSE body to trigger empty-stream -> non-streaming fallback
              return new Response('', {
                status: 200,
                headers: {
                  'Content-Type': 'text/event-stream',
                  'request-id': 'req_m1_empty_sse',
                },
              })
            }
            nonStreamHits++
            return new Response(
              JSON.stringify({
                id: 'msg_m1_fallback',
                type: 'message',
                role: 'assistant',
                model: body.model ?? 'claude-sonnet-4-6',
                content: [
                  {
                    type: 'text',
                    text: 'Non-streaming HTTP fallback succeeded.',
                  },
                ],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: {
                  input_tokens: 400,
                  output_tokens: 20,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              }),
              {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'request-id': 'req_m1_nonstream_1',
                },
              },
            )
          }
          return new Response('Not found', { status: 404 })
        },
      })
      activeServers.push(server)

      const configDir = makeTempDir('copilot-m1-fallback-')
      const proc = Bun.spawn(
        [
          'bun',
          'run',
          CLI_ENTRY,
          '-p',
          'Trigger fallback',
          '--output-format',
          'json',
          '--model',
          'sonnet',
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            CLAUDE_CONFIG_DIR: configDir,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
            ANTHROPIC_API_KEY: 'sk-ant-api03-fallback-test-key',
            COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )

      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode).toBe(0)
      expect(streamHits).toBe(1)
      expect(nonStreamHits).toBe(1)
      const parsed = JSON.parse(stdout) as {
        subtype: string
        result: string
        total_cost_usd: number
      }
      expect(parsed.subtype).toBe('success')
      expect(parsed.result).toBe('Non-streaming HTTP fallback succeeded.')
      expect(parsed.total_cost_usd).toBeGreaterThan(0)
    },
    15_000,
  )

  test(
    'auth status and auth logout CLI subcommands inspect API key auth and clean credentials',
    async () => {
      const configDir = makeTempDir('copilot-m1-auth-cli-')
      const credsFile = join(configDir, '.credentials.json')
      writeFileSync(
        credsFile,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-cli-test',
            refreshToken: 'sk-ant-ort01-cli-test',
            expiresAt: Date.now() + 3_600_000,
            scopes: ['user:inference'],
            subscriptionType: 'pro',
            rateLimitTier: null,
          },
        }),
        'utf-8',
      )

      const env = {
        ...process.env,
        NODE_ENV: 'production',
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: 'sk-ant-api03-cli-status-key',
        COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }

      const statusProc = Bun.spawn(['bun', 'run', CLI_ENTRY, 'auth', 'status'], {
        cwd: REPO_ROOT,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [statusOut, , statusExit] = await Promise.all([
        new Response(statusProc.stdout).text(),
        new Response(statusProc.stderr).text(),
        statusProc.exited,
      ])
      expect(statusExit).toBe(0)
      const statusJson = JSON.parse(statusOut) as {
        loggedIn: boolean
        apiProvider: string
      }
      expect(statusJson.loggedIn).toBe(true)
      expect(statusJson.apiProvider).toBe('firstParty')

      const logoutProc = Bun.spawn(['bun', 'run', CLI_ENTRY, 'auth', 'logout'], {
        cwd: REPO_ROOT,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [logoutOut, , logoutExit] = await Promise.all([
        new Response(logoutProc.stdout).text(),
        new Response(logoutProc.stderr).text(),
        logoutProc.exited,
      ])
      expect(logoutExit).toBe(0)
      expect(logoutOut).toContain('Successfully logged out')
      expect(existsSync(credsFile)).toBe(false)
    },
    15_000,
  )
})
