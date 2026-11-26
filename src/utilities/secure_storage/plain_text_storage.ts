/**
 * Cross-platform 0600 plaintext credential file storage
 * (`<CLAUDE_CONFIG_DIR>/.credentials.json`).
 */

import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../env_utils.js'
import { isEnoent } from '../errors.js'
import { getFsImplementation } from '../fs_operations.js'
import { jsonParse, jsonStringify } from '../slow_operations.js'
import type {
  SecureStorage,
  SecureStorageData,
  SecureStorageUpdateResult,
} from './types.js'

/**
 * Returns the absolute path to the `.credentials.json` plaintext storage file.
 */
export function getPlainTextCredentialsPath(): string {
  return join(getClaudeConfigHomeDir(), '.credentials.json')
}

export const plainTextStorage: SecureStorage = {
  name: 'plaintext',

  read(): SecureStorageData | null {
    const storagePath = getPlainTextCredentialsPath()
    try {
      const content = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf-8',
      })
      return jsonParse(content) as SecureStorageData
    } catch {
      return null
    }
  },

  async readAsync(): Promise<SecureStorageData | null> {
    const storagePath = getPlainTextCredentialsPath()
    try {
      const content = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf-8',
      })
      return jsonParse(content) as SecureStorageData
    } catch {
      return null
    }
  },

  update(data: SecureStorageData): SecureStorageUpdateResult {
    const storagePath = getPlainTextCredentialsPath()
    const storageDir = dirname(storagePath)
    try {
      mkdirSync(storageDir, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { success: false }
      }
    }

    try {
      writeFileSync(storagePath, jsonStringify(data), {
        encoding: 'utf-8',
        mode: 0o600,
      })
      try {
        chmodSync(storagePath, 0o600)
      } catch {
        // Windows chmod may not support full POSIX mode bits
      }
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    }
  },

  delete(): boolean {
    const storagePath = getPlainTextCredentialsPath()
    try {
      unlinkSync(storagePath)
      return true
    } catch (error) {
      if (isEnoent(error)) {
        return true
      }
      return false
    }
  },
}
