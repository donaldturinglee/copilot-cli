/**
 * Lightweight macOS Keychain helpers (intentionally free of execa so startup
 * keychain prefetch stays fast).
 */

import { createHash } from 'crypto'
import { userInfo } from 'os'
import { getOauthConfig } from '../../constants/oauth.js'
import { getClaudeConfigHomeDir } from '../env_utils.js'
import type { SecureStorageData } from './types.js'

export const CREDENTIALS_SERVICE_SUFFIX = '-credentials'
export const KEYCHAIN_CACHE_TTL_MS = 30_000

export interface KeychainCacheState {
  cache: { data: SecureStorageData | null; cachedAt: number }
  generation: number
  readInFlight: Promise<SecureStorageData | null> | null
}

export const keychainCacheState: KeychainCacheState = {
  cache: { data: null, cachedAt: 0 },
  generation: 0,
  readInFlight: null,
}

/**
 * Computes the macOS Keychain service name, scoping by SHA-256 prefix when a
 * custom `CLAUDE_CONFIG_DIR` is active.
 */
export function getMacOsKeychainStorageServiceName(serviceSuffix = ''): string {
  const configDir = getClaudeConfigHomeDir()
  const isDefaultDir = !process.env.CLAUDE_CONFIG_DIR
  const dirHash = isDefaultDir
    ? ''
    : '-' + createHash('sha256').update(configDir).digest('hex').substring(0, 8)
  return `Claude Code${getOauthConfig().OAUTH_FILE_SUFFIX}${serviceSuffix}${dirHash}`
}

/**
 * Returns the OS account username used as the macOS Keychain account key.
 */
export function getUsername(): string {
  try {
    return process.env.USER || userInfo().username || 'claude-code-user'
  } catch {
    return 'claude-code-user'
  }
}

/**
 * Clears the in-memory keychain read cache and advances the generation counter
 * so any in-flight async read cannot overwrite newer mutations.
 */
export function clearKeychainCache(): void {
  keychainCacheState.cache = { data: null, cachedAt: 0 }
  keychainCacheState.generation++
  keychainCacheState.readInFlight = null
}

/**
 * Primes the keychain cache from startup prefetch stdout if no read has already
 * populated it.
 */
export function primeKeychainCacheFromPrefetch(stdout: string): void {
  if (keychainCacheState.cache.cachedAt !== 0) {
    return
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    keychainCacheState.cache = { data: null, cachedAt: Date.now() }
    return
  }
  try {
    const parsed = JSON.parse(trimmed) as SecureStorageData
    keychainCacheState.cache = { data: parsed, cachedAt: Date.now() }
  } catch {
    keychainCacheState.cache = { data: null, cachedAt: Date.now() }
  }
}
