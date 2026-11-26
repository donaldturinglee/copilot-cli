/**
 * Reads OAuth tokens and API keys passed via file descriptors (and persists
 * them to well-known 0600 files for subprocesses in remote CCR containers).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  getApiKeyFromFd,
  getOauthTokenFromFd,
  setApiKeyFromFd,
  setOauthTokenFromFd,
} from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './env_utils.js'
import { isEnoent } from './errors.js'

export const CCR_TOKEN_DIR = '/home/claude/.claude/remote'
export const CCR_OAUTH_TOKEN_PATH = join(CCR_TOKEN_DIR, '.oauth_token')
export const CCR_API_KEY_PATH = join(CCR_TOKEN_DIR, '.api_key')
export const CCR_SESSION_INGRESS_TOKEN_PATH = join(
  CCR_TOKEN_DIR,
  '.session_ingress_token',
)

function maybePersistTokenForSubprocesses(
  filePath: string,
  token: string,
  tokenName: string,
): void {
  if (!isEnvTruthy(process.env.COPILOT_CLI_REMOTE)) {
    return
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    writeFileSync(filePath, token, { encoding: 'utf-8', mode: 0o600 })
  } catch (error) {
    logForDebugging(
      `Failed to persist ${tokenName} for subprocesses: ${String(error)}`,
    )
  }
}

function readTokenFromWellKnownFile(
  filePath: string,
  tokenName: string,
): string | null {
  try {
    const token = readFileSync(filePath, { encoding: 'utf-8' }).trim()
    return token || null
  } catch (error) {
    if (!isEnoent(error)) {
      logForDebugging(
        `Failed to read ${tokenName} from ${filePath}: ${String(error)}`,
      )
    }
    return null
  }
}

function getFdDevicePath(fd: number): string {
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    return `/dev/fd/${fd}`
  }
  return `/proc/self/fd/${fd}`
}

function getCredentialFromFd({
  envVar,
  wellKnownPath,
  tokenName,
  getCached,
  setCached,
}: {
  envVar: string
  wellKnownPath: string
  tokenName: string
  getCached: () => string | null | undefined
  setCached: (value: string | null) => void
}): string | null {
  const cached = getCached()
  if (cached !== undefined) {
    return cached
  }

  const rawFd = process.env[envVar]
  if (rawFd) {
    const fd = Number(rawFd)
    if (Number.isInteger(fd) && fd >= 0) {
      try {
        const fdPath = getFdDevicePath(fd)
        const token = readFileSync(fdPath, { encoding: 'utf-8' }).trim()
        if (token) {
          maybePersistTokenForSubprocesses(wellKnownPath, token, tokenName)
          setCached(token)
          return token
        }
      } catch (error) {
        logForDebugging(
          `Failed to read ${tokenName} from FD ${fd}: ${String(error)}`,
        )
      }
    }
  }

  const fromFile = readTokenFromWellKnownFile(wellKnownPath, tokenName)
  setCached(fromFile)
  return fromFile
}

/**
 * Reads an OAuth token from `COPILOT_CLI_OAUTH_TOKEN_FILE_DESCRIPTOR` or the
 * remote CCR well-known token file, caching the result in bootstrap state.
 */
export function getOauthTokenFromFileDescriptor(): string | null {
  return getCredentialFromFd({
    envVar: 'COPILOT_CLI_OAUTH_TOKEN_FILE_DESCRIPTOR',
    wellKnownPath: CCR_OAUTH_TOKEN_PATH,
    tokenName: 'OAuth token',
    getCached: getOauthTokenFromFd,
    setCached: setOauthTokenFromFd,
  })
}

/**
 * Reads an Anthropic API key from `COPILOT_CLI_API_KEY_FILE_DESCRIPTOR` or the
 * remote CCR well-known API key file, caching the result in bootstrap state.
 */
export function getApiKeyFromFileDescriptor(): string | null {
  return getCredentialFromFd({
    envVar: 'COPILOT_CLI_API_KEY_FILE_DESCRIPTOR',
    wellKnownPath: CCR_API_KEY_PATH,
    tokenName: 'API key',
    getCached: getApiKeyFromFd,
    setCached: setApiKeyFromFd,
  })
}
