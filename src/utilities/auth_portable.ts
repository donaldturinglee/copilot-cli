/**
 * Portable API key config normalization and macOS Keychain legacy API key removal.
 */

import { execa } from 'execa'
import { getMacOsKeychainStorageServiceName } from './secure_storage/mac_os_keychain_helpers.js'

/**
 * Returns the last 20 characters of an API key for approved/rejected config matching.
 */
export function normalizeApiKeyForConfig(apiKey: string): string {
  return apiKey.slice(-20)
}

/**
 * Deletes the legacy API key entry from the macOS Keychain, throwing if `security` fails.
 */
export async function maybeRemoveApiKeyFromMacOsKeychainThrows(): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  const serviceName = getMacOsKeychainStorageServiceName('')
  const result = await execa(
    `security delete-generic-password -a $USER -s "${serviceName}"`,
    { shell: true, reject: false },
  )
  if (result.exitCode !== 0 && result.exitCode !== 44) {
    throw new Error(
      `Failed to remove API key from macOS Keychain (exit code ${result.exitCode}): ${result.stderr}`,
    )
  }
}
