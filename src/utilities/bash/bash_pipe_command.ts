/**
 * Safe `< /dev/null` attachment for pipelines and compound shell commands.
 */

import { shouldAddStdinRedirect } from './shell_quoting.js'

/**
 * Wraps `command` in a group with `< /dev/null` when safe, ensuring stdin is
 * closed for every stage without changing exit status or breaking pipelines.
 */
export function rearrangePipeCommand(command: string): string {
  const trimmed = command.trim()
  if (!shouldAddStdinRedirect(trimmed)) {
    return trimmed
  }
  return `{ ${trimmed}\n} < /dev/null`
}
