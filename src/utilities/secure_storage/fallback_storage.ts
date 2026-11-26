/**
 * Composite credential storage with automatic migration and shadow-token cleanup
 * between a primary backend (e.g. macOS Keychain) and secondary fallback (plaintext).
 */

import type {
  SecureStorage,
  SecureStorageData,
  SecureStorageUpdateResult,
} from './types.js'

/**
 * Wraps a primary and secondary `SecureStorage` backend.
 * On writes:
 * - If primary succeeds on initial migration (`primary` was empty), removes stale secondary.
 * - If primary fails and secondary succeeds, deletes any stale primary entry so it cannot
 *   shadow freshly written tokens on subsequent reads.
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,

    read(): SecureStorageData | null {
      const primaryData = primary.read()
      if (primaryData !== null && primaryData !== undefined) {
        return primaryData
      }
      return secondary.read() ?? {}
    },

    async readAsync(): Promise<SecureStorageData | null> {
      const primaryData = await primary.readAsync()
      if (primaryData !== null && primaryData !== undefined) {
        return primaryData
      }
      return (await secondary.readAsync()) ?? {}
    },

    update(data: SecureStorageData): SecureStorageUpdateResult {
      const primaryDataBefore = primary.read()
      const primaryResult = primary.update(data)

      if (primaryResult.success) {
        if (primaryDataBefore === null) {
          secondary.delete()
        }
        return primaryResult
      }

      const fallbackResult = secondary.update(data)
      if (fallbackResult.success) {
        if (primaryDataBefore !== null) {
          primary.delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },

    delete(): boolean {
      const primarySuccess = primary.delete()
      const secondarySuccess = secondary.delete()
      return primarySuccess || secondarySuccess
    },
  }
}
