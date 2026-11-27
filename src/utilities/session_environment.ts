/**
 * Session-scoped environment script paths (`CLAUDE_ENV_FILE`) sourced by shell
 * invocations.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './env_utils.js'

export function getSessionEnvDir(): string {
  return join(getClaudeConfigHomeDir(), 'session-env', getSessionId())
}

/**
 * Returns existing shell env scripts that should be sourced before running
 * commands (starting with `CLAUDE_ENV_FILE` if configured and present).
 */
export function getSessionEnvFiles(): string[] {
  const files: string[] = []
  const envFile = process.env.CLAUDE_ENV_FILE
  if (envFile && existsSync(envFile)) {
    files.push(envFile)
  }
  const sessionScript = join(getSessionEnvDir(), 'env.sh')
  if (existsSync(sessionScript)) {
    files.push(sessionScript)
  }
  return files
}
