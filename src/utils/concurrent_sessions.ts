import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanup_registry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './env_utils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isFeatureEnabled } from './feature_flags.js'
import { isProcessRunning } from './generic_process_utils.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slow_operations.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

let agentIdProvider: (() => string | undefined) | undefined

/**
 * Registers an optional provider for the current teammate/agent ID
 * (wired by Phase 9 teammate module). Falls back to COPILOT_CLI_AGENT_ID.
 */
export function registerConcurrentSessionsAgentIdProvider(
  provider: () => string | undefined,
): void {
  agentIdProvider = provider
}

function getCurrentAgentId(): string | undefined {
  return agentIdProvider?.() ?? process.env.COPILOT_CLI_AGENT_ID
}

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

function envSessionKind(): SessionKind | undefined {
  if (isFeatureEnabled('BG_SESSIONS')) {
    const kind = process.env.COPILOT_CLI_SESSION_KIND
    if (kind === 'bg' || kind === 'daemon' || kind === 'daemon-worker') {
      return kind
    }
  }
  return undefined
}

export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * Writes a PID file for this top-level session and registers exit cleanup.
 */
export async function registerSession(): Promise<boolean> {
  if (getCurrentAgentId() != null) return false

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  registerCleanup(async () => {
    try {
      await unlink(pidFile)
    } catch {
      // ENOENT is fine
    }
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    await writeFile(
      pidFile,
      jsonStringify({
        pid: process.pid,
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        startedAt: Date.now(),
        kind,
        entrypoint: process.env.COPILOT_CLI_ENTRYPOINT,
        ...(isFeatureEnabled('UDS_INBOX')
          ? { messagingSocketPath: process.env.COPILOT_CLI_MESSAGING_SOCKET }
          : {}),
        ...(isFeatureEnabled('BG_SESSIONS')
          ? {
              name: process.env.COPILOT_CLI_SESSION_NAME,
              logPath: process.env.COPILOT_CLI_SESSION_LOG,
              agent: process.env.COPILOT_CLI_AGENT,
            }
          : {}),
      }),
    )
    onSessionSwitch(sessionId => {
      void updatePidFile({ sessionId })
    })
    return true
  } catch (error) {
    logForDebugging(
      `[concurrentSessions] register failed: ${errorMessage(error)}`,
    )
    return false
  }
}

async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(pidFile, jsonStringify({ ...data, ...patch }))
  } catch (error) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(error)}`,
    )
  }
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!isFeatureEnabled('BG_SESSIONS')) return
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * Counts live concurrent CLI sessions and sweeps stale PID files (except on WSL).
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (error) {
    if (!isFsInaccessible(error)) {
      logForDebugging(
        `[concurrentSessions] readdir failed: ${errorMessage(error)}`,
      )
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}
