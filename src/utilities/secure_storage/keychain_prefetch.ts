/**
 * Non-blocking startup macOS Keychain prefetch for OAuth tokens and legacy API keys.
 */

import { execFile } from 'child_process'
import { isBareMode } from '../env_utils.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
  getUsername,
  primeKeychainCacheFromPrefetch,
} from './mac_os_keychain_helpers.js'

const KEYCHAIN_PREFETCH_TIMEOUT_MS = 10_000

let prefetchPromise: Promise<void> | null = null
let legacyApiKeyResult: { completed: boolean; apiKey: string | null } = {
  completed: false,
  apiKey: null,
}

function readKeychainEntryAsync(
  serviceName: string,
  username: string,
): Promise<{ stdout: string; timedOut: boolean; ok: boolean }> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: {
      stdout: string
      timedOut: boolean
      ok: boolean
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const child = execFile(
      'security',
      ['find-generic-password', '-a', username, '-w', '-s', serviceName],
      { encoding: 'utf-8' },
      (error, stdout) => {
        if (error) {
          const killed = Boolean((error as { killed?: boolean }).killed)
          finish({ stdout: '', timedOut: killed, ok: false })
          return
        }
        finish({ stdout: stdout ?? '', timedOut: false, ok: true })
      },
    )

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Process already exited
      }
      finish({ stdout: '', timedOut: true, ok: false })
    }, KEYCHAIN_PREFETCH_TIMEOUT_MS)
    timer.unref?.()
  })
}

/**
 * Starts parallel macOS Keychain prefetches for OAuth credentials and legacy API key.
 * No-op on non-macOS platforms, in bare mode, or when already started.
 */
export function startKeychainPrefetch(): void {
  if (process.platform !== 'darwin' || prefetchPromise || isBareMode()) {
    return
  }

  const username = getUsername()
  const oauthService = getMacOsKeychainStorageServiceName(
    CREDENTIALS_SERVICE_SUFFIX,
  )
  const legacyService = getMacOsKeychainStorageServiceName('')

  prefetchPromise = Promise.all([
    readKeychainEntryAsync(oauthService, username).then(result => {
      if (!result.timedOut) {
        primeKeychainCacheFromPrefetch(result.ok ? result.stdout : '')
      }
    }),
    readKeychainEntryAsync(legacyService, username).then(result => {
      if (!result.timedOut) {
        const trimmed = result.ok ? result.stdout.trim() : ''
        legacyApiKeyResult = {
          completed: true,
          apiKey: trimmed || null,
        }
      }
    }),
  ]).then(() => undefined)
}

/**
 * Awaits any in-flight startup keychain prefetch.
 */
export async function ensureKeychainPrefetchCompleted(): Promise<void> {
  if (prefetchPromise) {
    await prefetchPromise
  }
}

/**
 * Returns the prefetched legacy API key result if prefetch completed.
 */
export function getLegacyApiKeyPrefetchResult(): {
  completed: boolean
  apiKey: string | null
} {
  return legacyApiKeyResult
}

/**
 * Clears cached legacy API key prefetch state (called on key save/delete or tests).
 */
export function clearLegacyApiKeyPrefetch(): void {
  prefetchPromise = null
  legacyApiKeyResult = { completed: false, apiKey: null }
}
