/**
 * Cross-platform credential storage selector.
 * Uses macOS Keychain with plaintext fallback on darwin, and 0600 plaintext
 * storage on Linux and Windows.
 */

import { createFallbackStorage } from './fallback_storage.js'
import { macOsKeychainStorage } from './mac_os_keychain_storage.js'
import { plainTextStorage } from './plain_text_storage.js'
import type { SecureStorage } from './types.js'

let storageOverrideForTesting: SecureStorage | null = null

/**
 * Overrides the active `SecureStorage` implementation during tests.
 */
export function setSecureStorageOverrideForTesting(
  storage: SecureStorage | null,
): void {
  storageOverrideForTesting = storage
}

/**
 * Returns the platform-appropriate `SecureStorage` implementation.
 */
export function getSecureStorage(): SecureStorage {
  if (storageOverrideForTesting) {
    return storageOverrideForTesting
  }
  if (process.platform === 'darwin') {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }
  return plainTextStorage
}
