/**
 * macOS Keychain credential storage using `security -i` stdin transport to
 * avoid exposing secrets in process argv, falling back to argv above 4032 bytes
 * (macOS `security -i` `fgets()` 4096B `BUFSIZ` limit).
 */

import { execaSync } from 'execa'
import { execFileNoThrow } from '../exec_file_no_throw.js'
import { jsonParse, jsonStringify } from '../slow_operations.js'
import {
  clearKeychainCache,
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
  getUsername,
  KEYCHAIN_CACHE_TTL_MS,
  keychainCacheState,
} from './mac_os_keychain_helpers.js'
import type {
  SecureStorage,
  SecureStorageData,
  SecureStorageUpdateResult,
} from './types.js'

/**
 * Maximum line length safe for macOS `security -i` interactive stdin (`BUFSIZ` 4096 - 64).
 */
export const SECURITY_STDIN_LINE_LIMIT = 4096 - 64

let cachedKeychainLocked: boolean | undefined

/**
 * Checks whether the macOS login keychain is currently locked (exit code 36).
 * Result is cached for the process lifetime.
 */
export function isMacOsKeychainLocked(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  if (cachedKeychainLocked !== undefined) {
    return cachedKeychainLocked
  }
  try {
    const result = execaSync('security', ['show-keychain-info'], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cachedKeychainLocked = result.exitCode === 36
  } catch {
    cachedKeychainLocked = false
  }
  return cachedKeychainLocked
}

/**
 * Resets cached keychain lock detection state in tests.
 */
export function resetKeychainLockedCacheForTesting(): void {
  cachedKeychainLocked = undefined
}

function parseKeychainJson(stdout: string): SecureStorageData | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  try {
    return jsonParse(trimmed) as SecureStorageData
  } catch {
    return null
  }
}

/**
 * Builds the `security -i` stdin command line for storing hex-encoded payload.
 */
export function buildKeychainStdinCommand(
  username: string,
  serviceName: string,
  hexValue: string,
): string {
  return `add-generic-password -U -a "${username}" -s "${serviceName}" -X "${hexValue}"\n`
}

export const macOsKeychainStorage: SecureStorage = {
  name: 'keychain',

  read(): SecureStorageData | null {
    const now = Date.now()
    const prev = keychainCacheState.cache
    if (prev.cachedAt > 0 && now - prev.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return prev.data
    }

    const serviceName = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const username = getUsername()
    try {
      const result = execaSync(
        'security',
        ['find-generic-password', '-a', username, '-w', '-s', serviceName],
        {
          reject: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      if (result.exitCode === 0 && typeof result.stdout === 'string') {
        const parsed = parseKeychainJson(result.stdout)
        keychainCacheState.cache = { data: parsed, cachedAt: Date.now() }
        return parsed
      }
      // Exit code 44 = item not found; any other failure uses stale-while-error.
      if (result.exitCode !== 44 && prev.data !== null) {
        keychainCacheState.cache = { data: prev.data, cachedAt: Date.now() }
        return prev.data
      }
      keychainCacheState.cache = { data: null, cachedAt: Date.now() }
      return null
    } catch {
      if (prev.data !== null) {
        keychainCacheState.cache = { data: prev.data, cachedAt: Date.now() }
        return prev.data
      }
      return null
    }
  },

  async readAsync(): Promise<SecureStorageData | null> {
    const now = Date.now()
    const prev = keychainCacheState.cache
    if (prev.cachedAt > 0 && now - prev.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return prev.data
    }
    if (keychainCacheState.readInFlight) {
      return keychainCacheState.readInFlight
    }

    const generation = keychainCacheState.generation
    const serviceName = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const username = getUsername()

    let promise: Promise<SecureStorageData | null> | null = null
    promise = (async (): Promise<SecureStorageData | null> => {
      try {
        const result = await execFileNoThrow('security', [
          'find-generic-password',
          '-a',
          username,
          '-w',
          '-s',
          serviceName,
        ])
        let resolved: SecureStorageData | null
        if (result.code === 0) {
          resolved = parseKeychainJson(result.stdout)
        } else if (result.code !== 44 && prev.data !== null) {
          resolved = prev.data
        } else {
          resolved = null
        }

        if (keychainCacheState.generation === generation) {
          keychainCacheState.cache = { data: resolved, cachedAt: Date.now() }
        }
        return resolved
      } catch {
        const fallback = prev.data
        if (keychainCacheState.generation === generation && fallback !== null) {
          keychainCacheState.cache = { data: fallback, cachedAt: Date.now() }
        }
        return fallback
      } finally {
        if (keychainCacheState.readInFlight === promise) {
          keychainCacheState.readInFlight = null
        }
      }
    })()

    keychainCacheState.readInFlight = promise
    return promise
  },

  update(data: SecureStorageData): SecureStorageUpdateResult {
    clearKeychainCache()
    const serviceName = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const username = getUsername()
    const jsonString = jsonStringify(data)
    const hexValue = Buffer.from(jsonString, 'utf-8').toString('hex')
    const stdinCommand = buildKeychainStdinCommand(
      username,
      serviceName,
      hexValue,
    )

    try {
      const result =
        stdinCommand.length <= SECURITY_STDIN_LINE_LIMIT
          ? execaSync('security', ['-i'], {
              input: stdinCommand,
              stdio: ['pipe', 'pipe', 'pipe'],
              reject: false,
            })
          : execaSync(
              'security',
              [
                'add-generic-password',
                '-U',
                '-a',
                username,
                '-s',
                serviceName,
                '-X',
                hexValue,
              ],
              {
                stdio: ['ignore', 'pipe', 'pipe'],
                reject: false,
              },
            )

      if (result.exitCode === 0) {
        keychainCacheState.cache = { data, cachedAt: Date.now() }
        return { success: true }
      }
      return { success: false }
    } catch {
      return { success: false }
    }
  },

  delete(): boolean {
    clearKeychainCache()
    const serviceName = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const username = getUsername()
    try {
      const result = execaSync(
        'security',
        ['delete-generic-password', '-a', username, '-s', serviceName],
        {
          reject: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      return result.exitCode === 0 || result.exitCode === 44
    } catch {
      return false
    }
  },
}
