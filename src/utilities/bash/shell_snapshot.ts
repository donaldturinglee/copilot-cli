/**
 * Session shell snapshot generator (`createAndSaveSnapshot`) that captures the
 * user's login shell environment (functions, options, aliases, PATH) once per
 * session so per-command spawns skip expensive `-l` login-shell startup.
 */

import { spawn } from 'child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { registerCleanup } from '../cleanup_registry.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../env_utils.js'
import { getPlatform } from '../platform.js'
import { ripgrepCommand } from '../ripgrep.js'
import { quoteShellCommand } from './shell_quoting.js'

const SNAPSHOT_TIMEOUT_MS = 5_000

const snapshotPromises = new Map<string, Promise<string | undefined>>()

/**
 * Generates an optional shell function wrapper pointing `rg` at the resolved
 * ripgrep binary so subcommands see consistent search tooling.
 */
export function createRipgrepShellIntegration(): string {
  const rg = ripgrepCommand()
  if (!rg) return ''
  return `if ! command -v rg >/dev/null 2>&1; then\n  rg() { ${quoteShellCommand(rg.command)} "$@"; }\nfi\n`
}

function getSnapshotsDir(): string {
  return join(getClaudeConfigHomeDir(), 'shell-snapshots')
}

function runSnapshotCapture(
  shellPath: string,
  shellName: string,
): Promise<string | undefined> {
  return new Promise(resolve => {
    const captureScript = [
      'printf "# Shell snapshot\\n"',
      'printf "export PATH=%s\\n" "$(printf \'%q\' "$PATH" 2>/dev/null || printf "\'%s\'" "$PATH")"',
      shellName === 'zsh' ? 'typeset -f 2>/dev/null || true' : 'declare -f 2>/dev/null || true',
    ].join('\n')

    const child = spawn(shellPath, ['-c', '-l', captureScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env },
    })

    let stdout = ''
    let settled = false
    const finish = (val: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(val)
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      finish(undefined)
    }, SNAPSHOT_TIMEOUT_MS)
    timer.unref?.()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 512 * 1024) {
        stdout += chunk
      }
    })
    child.on('error', () => finish(undefined))
    child.on('close', code => {
      if (code !== 0 && stdout.trim().length === 0) {
        finish(undefined)
        return
      }
      finish(stdout)
    })
  })
}

/**
 * Captures and persists a session-scoped shell snapshot file (mode `0o600`),
 * returning its path or `undefined` when snapshots are disabled or unavailable.
 */
export function createAndSaveSnapshot(
  shellPath: string,
): Promise<string | undefined> {
  if (
    isEnvTruthy(process.env.COPILOT_CLI_DISABLE_SHELL_SNAPSHOT) ||
    getPlatform() === 'windows' ||
    process.env.NODE_ENV === 'test'
  ) {
    return Promise.resolve(undefined)
  }

  const existing = snapshotPromises.get(shellPath)
  if (existing) {
    return existing
  }

  const promise = (async (): Promise<string | undefined> => {
    try {
      const shellName = basename(shellPath).replace(/\.exe$/i, '').toLowerCase()
      const captured = await runSnapshotCapture(shellPath, shellName)
      if (!captured) {
        return undefined
      }

      const dir = getSnapshotsDir()
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const snapshotPath = join(
        dir,
        `snapshot-${shellName}-${process.pid}-${Date.now()}.sh`,
      )
      const content = `${captured}\n${createRipgrepShellIntegration()}`
      writeFileSync(snapshotPath, content, { encoding: 'utf8', mode: 0o600 })

      registerCleanup(async () => {
        try {
          unlinkSync(snapshotPath)
        } catch {
          // ignore cleanup failure
        }
      })

      logForDebugging(`Created shell snapshot at ${snapshotPath}`)
      return snapshotPath
    } catch (error) {
      logForDebugging(
        `Shell snapshot capture skipped: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  })()

  snapshotPromises.set(shellPath, promise)
  return promise
}

/**
 * Resets cached snapshot promises (for tests).
 */
export function resetShellSnapshotsForTesting(): void {
  snapshotPromises.clear()
}
