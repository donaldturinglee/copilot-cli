/**
 * Synchronous write-time secret guard blocking credentials/keys from being
 * written into shared team memory (`<autoMemPath>/team/`).
 */

import { isTeamMemPath } from '../../memdir/team_mem_paths.js'
import { scanForSecrets } from './secret_scanner.js'

/**
 * Checks whether `content` intended for `filePath` (inside team memory)
 * contains any high-confidence secret pattern. Returns an explanatory error
 * string if blocked, or `null` if safe.
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  if (!isTeamMemPath(filePath)) {
    return null
  }
  const matches = scanForSecrets(content)
  if (matches.length === 0) {
    return null
  }
  const labels = matches.map(m => m.label).join(', ')
  return `Blocked write to shared team memory (${filePath}): detected potential secret(s): ${labels}. Never store credentials or private keys in team memory.`
}
