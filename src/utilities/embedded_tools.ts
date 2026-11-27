/**
 * Detection helpers for bundled/embedded search binaries (ripgrep).
 */

import { existsSync } from 'fs'
import { isRunningWithBun } from './bundled_mode.js'

/**
 * Returns true if a standalone embedded search binary is packaged with the
 * current executable.
 */
export function hasEmbeddedSearchTools(): boolean {
  const override = process.env.COPILOT_CLI_EMBEDDED_RG_PATH
  if (override && existsSync(override)) {
    return true
  }
  return false
}

/**
 * Returns the path to the embedded search binary if available.
 */
export function embeddedSearchToolsBinaryPath(): string | undefined {
  const override = process.env.COPILOT_CLI_EMBEDDED_RG_PATH
  if (override && existsSync(override)) {
    return override
  }
  if (isRunningWithBun() && process.env.COPILOT_CLI_RG_BINARY) {
    return process.env.COPILOT_CLI_RG_BINARY
  }
  return undefined
}
