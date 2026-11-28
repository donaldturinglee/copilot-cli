/**
 * Session startup metadata & environment variable file loader
 * (`~/.copilot/session-env/<sessionId>/`).
 */

import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './env_utils.js'

export type SessionEnvHookEvent =
  | 'setup'
  | 'sessionstart'
  | 'cwdchanged'
  | 'filechanged'

/**
 * Returns the per-session hook environment script directory
 * (`~/.copilot/session-env/<sessionId>`).
 */
export function getSessionEnvDir(sessionId: string = getSessionId()): string {
  return join(getClaudeConfigHomeDir(), 'session-env', sessionId)
}

/**
 * Returns the file path for a specific lifecycle hook's env-export script.
 */
export function getSessionEnvScriptPath(
  event: SessionEnvHookEvent,
  index: number,
  sessionId: string = getSessionId(),
): string {
  return join(getSessionEnvDir(sessionId), `${event}-hook-${index}.sh`)
}

/**
 * Persists exported shell environment lines from a lifecycle hook under
 * `~/.copilot/session-env/<sessionId>/`.
 */
export async function writeSessionEnvScript(
  event: SessionEnvHookEvent,
  index: number,
  content: string,
  sessionId: string = getSessionId(),
): Promise<string> {
  const dir = getSessionEnvDir(sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const filePath = getSessionEnvScriptPath(event, index, sessionId)
  await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 })
  return filePath
}
