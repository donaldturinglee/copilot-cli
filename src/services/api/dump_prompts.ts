/**
 * Request ring buffer and off-critical-path JSONL prompt dumper (ant/debug).
 */

import { appendFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../../utilities/env_utils.js'
import { jsonStringify } from '../../utilities/slow_operations.js'

const MAX_CACHED_REQUESTS = 5

export interface DumpedPromptEntry {
  timestamp: string
  initFingerprint: string
  url: string
  body: unknown
}

const recentRequests: DumpedPromptEntry[] = []

/**
 * Returns the ring buffer of recent dumped API request bodies (up to 5).
 */
export function getRecentDumpedRequests(): ReadonlyArray<DumpedPromptEntry> {
  return recentRequests
}

/**
 * Clears the in-memory request ring buffer (for tests).
 */
export function clearDumpedRequestsForTesting(): void {
  recentRequests.length = 0
}

function computeInitFingerprint(parsedBody: Record<string, unknown>): string {
  const model = typeof parsedBody.model === 'string' ? parsedBody.model : ''
  const tools = Array.isArray(parsedBody.tools)
    ? parsedBody.tools
        .map(t =>
          t && typeof t === 'object' && 'name' in t
            ? String((t as { name?: unknown }).name)
            : '',
        )
        .join(',')
    : ''
  const sysLen = Array.isArray(parsedBody.system)
    ? parsedBody.system.length
    : typeof parsedBody.system === 'string'
      ? parsedBody.system.length
      : 0
  return `${model}|${tools}|${sysLen}`
}

/**
 * Returns true if prompt dumping is enabled (`USER_TYPE === 'ant'` or
 * `COPILOT_CLI_DUMP_PROMPTS=1`).
 */
export function isDumpPromptsEnabled(): boolean {
  return (
    isEnvTruthy(process.env.COPILOT_CLI_DUMP_PROMPTS) ||
    (process.env.USER_TYPE === 'ant' &&
      isEnvTruthy(process.env.DUMP_PROMPTS))
  )
}

/**
 * Wraps `fetch` to record request payloads in a 5-entry ring buffer and
 * asynchronously append them to `{configDir}/dump-prompts/{sessionId}.jsonl`
 * via `setImmediate` so I/O stays off the request critical path.
 */
export function createDumpPromptsFetch(
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch | undefined {
  if (!isDumpPromptsEnabled()) {
    return undefined
  }
  const dumpPath = join(
    getClaudeConfigHomeDir(),
    'dump-prompts',
    `${getSessionId()}.jsonl`,
  )

  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const rawBody = init?.body
    if (typeof rawBody === 'string') {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      setImmediate(() => {
        try {
          const parsed = JSON.parse(rawBody) as Record<string, unknown>
          const entry: DumpedPromptEntry = {
            timestamp: new Date().toISOString(),
            initFingerprint: computeInitFingerprint(parsed),
            url,
            body: parsed,
          }
          recentRequests.push(entry)
          if (recentRequests.length > MAX_CACHED_REQUESTS) {
            recentRequests.shift()
          }
          void mkdir(dirname(dumpPath), { recursive: true })
            .then(() =>
              appendFile(dumpPath, jsonStringify(entry) + '\n', 'utf-8'),
            )
            .catch(() => {})
        } catch {
          // Ignore non-JSON bodies
        }
      })
    }
    return baseFetch(input, init)
  }

  return wrapped as typeof fetch
}
