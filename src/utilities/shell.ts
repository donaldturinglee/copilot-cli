/**
 * Cross-platform shell discovery, CWD persistence & recovery, and per-command
 * spawn orchestrator (`exec`, `findSuitableShell`, `getShellConfig`, `setCwd`).
 */

import { spawn } from 'child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  getOriginalCwd,
  setCwdState,
} from '../bootstrap/state.js'
import { createAndSaveSnapshot } from './bash/shell_snapshot.js'
import { randomUUID } from './crypto.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './env_utils.js'
import { getPlatform } from './platform.js'
import { getSessionEnvFiles } from './session_environment.js'
import { getSessionEnvVars } from './session_env_vars.js'
import { BashProvider } from './shell/bash_provider.js'
import { findPowerShell } from './shell/powershell_detection.js'
import { PowerShellProvider } from './shell/powershell_provider.js'
import type { ShellKind, ShellProvider } from './shell/shell_provider.js'
import {
  createAbortedCommand,
  createFailedCommand,
  type ExecResult,
  type ShellCommand,
  type ShellCommandProgress,
  wrapSpawn,
} from './shell_command.js'
import { getDefaultBashTimeoutMs } from './shell_config.js'
import { whichSync } from './which.js'
import { posixPathToWindowsPath } from './windows_paths.js'

const WINDOWS_GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
]

export interface ShellConfig {
  binShell: string
  provider: BashProvider
}

let cachedBashShellPath: string | null | undefined

/**
 * Locates a suitable POSIX/Bash shell executable across macOS, Linux, and
 * Windows (Git Bash).
 */
export function findSuitableShell(): string | null {
  if (cachedBashShellPath !== undefined) {
    return cachedBashShellPath
  }

  const explicit =
    process.env.COPILOT_CLI_GIT_BASH_PATH ||
    (process.env.COPILOT_CLI_SHELL &&
    process.env.COPILOT_CLI_SHELL.toLowerCase() !== 'powershell' &&
    process.env.COPILOT_CLI_SHELL.toLowerCase() !== 'pwsh'
      ? process.env.COPILOT_CLI_SHELL
      : undefined)

  if (explicit && existsSync(explicit)) {
    cachedBashShellPath = explicit
    return cachedBashShellPath
  }

  if (getPlatform() === 'windows') {
    for (const candidate of WINDOWS_GIT_BASH_CANDIDATES) {
      if (existsSync(candidate)) {
        cachedBashShellPath = candidate
        return cachedBashShellPath
      }
    }
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      const userGitBash = join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')
      if (existsSync(userGitBash)) {
        cachedBashShellPath = userGitBash
        return cachedBashShellPath
      }
    }
    const fromPath = whichSync('bash')
    if (fromPath && !fromPath.toLowerCase().includes('\\system32\\bash.exe')) {
      cachedBashShellPath = fromPath
      return cachedBashShellPath
    }
    cachedBashShellPath = null
    return null
  }

  // POSIX: prefer $SHELL if bash/zsh, otherwise /bin/bash or /bin/sh
  const envShell = process.env.SHELL
  if (
    envShell &&
    existsSync(envShell) &&
    (envShell.endsWith('/bash') || envShell.endsWith('/zsh'))
  ) {
    cachedBashShellPath = envShell
    return cachedBashShellPath
  }

  const bash = whichSync('bash') || (existsSync('/bin/bash') ? '/bin/bash' : null)
  if (bash) {
    cachedBashShellPath = bash
    return cachedBashShellPath
  }

  const sh = whichSync('sh') || (existsSync('/bin/sh') ? '/bin/sh' : null)
  cachedBashShellPath = sh
  return cachedBashShellPath
}

export function resetShellDetectionForTesting(): void {
  cachedBashShellPath = undefined
}

export function getShellConfig(): ShellConfig | null {
  const binShell = findSuitableShell()
  if (!binShell) return null
  return {
    binShell,
    provider: new BashProvider(binShell),
  }
}

export function getPsProvider(): PowerShellProvider | null {
  const detected = findPowerShell()
  if (!detected) return null
  return new PowerShellProvider(detected.path)
}

/**
 * Updates the persistent working directory state if `dir` exists and is a
 * directory.
 */
export function setCwd(dir: string): boolean {
  const resolved = resolve(dir)
  try {
    if (statSync(resolved).isDirectory()) {
      setCwdState(resolved)
      return true
    }
  } catch {
    // Directory does not exist
  }
  return false
}

/**
 * Ensures the active CWD still exists on disk; recovers to `originalCwd` if
 * it was deleted by a command.
 */
export function ensureValidCwd(): string {
  const current = getCwd()
  try {
    if (statSync(current).isDirectory()) {
      return current
    }
  } catch {
    // Deleted CWD
  }
  const fallback = getOriginalCwd()
  setCwdState(fallback)
  logForDebugging(`Recovered deleted working directory back to ${fallback}`)
  return fallback
}

function parseCapturedCwd(raw: string): string | null {
  const cleaned = raw.replace(/^\uFEFF/, '').trim()
  if (!cleaned) return null
  if (getPlatform() === 'windows' && /^\/[a-zA-Z](?:\/|$)/.test(cleaned)) {
    try {
      return resolve(posixPathToWindowsPath(cleaned))
    } catch {
      return null
    }
  }
  return resolve(cleaned)
}

export interface ShellExecOptions {
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string | undefined>
  runInBackground?: boolean
  persistCwd?: boolean
  onProgress?: (progress: ShellCommandProgress) => void
  onBackgroundExit?: (result: ExecResult) => void
}

/**
 * Spawns a single command under the requested shell provider (`bash` or
 * `powershell`), capturing stdout/stderr to disk and synchronously persisting
 * the resulting working directory on foreground completion.
 */
export async function exec(
  command: string,
  abortSignal: AbortSignal | undefined,
  shellKind: ShellKind = 'bash',
  options: ShellExecOptions = {},
): Promise<ShellCommand> {
  if (abortSignal?.aborted) {
    return createAbortedCommand()
  }

  let provider: ShellProvider | null = null
  let snapshotPath: string | undefined

  if (shellKind === 'powershell') {
    provider = getPsProvider()
    if (!provider) {
      return createFailedCommand(
        'PowerShell executable (pwsh or powershell) not found on PATH.',
      )
    }
  } else {
    const config = getShellConfig()
    if (!config) {
      return createFailedCommand(
        'No suitable bash shell found. Install Git Bash or set COPILOT_CLI_GIT_BASH_PATH.',
      )
    }
    provider = config.provider
    snapshotPath = await createAndSaveSnapshot(config.binShell)
  }

  const workingDir = options.cwd ?? ensureValidCwd()
  const cwdFile = join(tmpdir(), `copilot-cli-cwd-${process.pid}-${randomUUID()}`)
  const envFiles = shellKind === 'bash' ? getSessionEnvFiles() : []
  const shellPrefix =
    shellKind === 'bash' ? process.env.COPILOT_CLI_SHELL_PREFIX : undefined

  const wrappedScript = provider.buildCommand({
    command,
    cwdFile,
    snapshotPath,
    envFiles,
    shellPrefix,
  })

  const spawnArgs = provider.getSpawnArgs(wrappedScript, {
    hasSnapshot: Boolean(snapshotPath),
  })

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...getSessionEnvVars(),
    ...(options.env ?? {}),
    COPILOT_CLI_SHELL_SESSION: '1',
  }

  const child = spawn(provider.shellPath, spawnArgs, {
    cwd: workingDir,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const timeoutMs = options.timeoutMs ?? getDefaultBashTimeoutMs()
  const persistCwd = options.persistCwd !== false

  const shellCmd = wrapSpawn(child, {
    timeoutMs,
    abortSignal,
    onProgress: options.onProgress,
    onBackgroundExit: result => {
      try {
        unlinkSync(cwdFile)
      } catch {
        // ignore
      }
      options.onBackgroundExit?.(result)
    },
  })

  if (options.runInBackground) {
    shellCmd.background()
    return shellCmd
  }

  // Wrap result promise to synchronously persist CWD before caller resumes
  const persistedResult = shellCmd.result.then(res => {
    try {
      if (persistCwd && !res.backgroundTaskId && existsSync(cwdFile)) {
        const rawCwd = readFileSync(cwdFile, 'utf8')
        const nextCwd = parseCapturedCwd(rawCwd)
        if (nextCwd) {
          if (
            isEnvTruthy(process.env.COPILOT_CLI_BASH_MAINTAIN_PROJECT_WORKING_DIR)
          ) {
            setCwd(getOriginalCwd())
          } else {
            setCwd(nextCwd)
          }
        }
      }
    } catch {
      // Ignore CWD read failure
    } finally {
      if (!res.backgroundTaskId) {
        try {
          unlinkSync(cwdFile)
        } catch {
          // ignore
        }
      }
    }
    return res
  })

  return {
    taskId: shellCmd.taskId,
    outputPath: shellCmd.outputPath,
    result: persistedResult,
    kill: () => shellCmd.kill(),
    background: id => shellCmd.background(id),
    cleanup: () => shellCmd.cleanup(),
  }
}
