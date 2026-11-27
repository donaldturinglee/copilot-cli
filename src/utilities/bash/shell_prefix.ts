/**
 * `COPILOT_CLI_SHELL_PREFIX` command prefix formatter.
 */

import { quoteShellCommand } from './shell_quoting.js'

/**
 * Prepends an optional shell wrapper prefix (e.g. `timeout 60` or a custom
 * wrapper script from `COPILOT_CLI_SHELL_PREFIX`) to `command`.
 */
export function formatShellPrefixCommand(
  prefix: string | undefined,
  command: string,
): string {
  const trimmedPrefix = prefix?.trim()
  if (!trimmedPrefix) {
    return command
  }
  return `${trimmedPrefix} ${quoteShellCommand(command)}`
}
