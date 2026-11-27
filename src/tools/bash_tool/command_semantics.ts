/**
 * Semantic interpretation of non-zero exit codes for well-known Unix commands
 * (e.g. `grep`/`rg` exit 1 = no matches rather than an error, `diff` exit 1 =
 * files differ).
 */

import { extractCommandPrefix } from '../../utilities/shell/prefix.js'

export interface CommandExitSemantics {
  isError: boolean
  message?: string
}

export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): CommandExitSemantics {
  if (exitCode === 0) {
    return { isError: false }
  }

  const prefix = extractCommandPrefix(command)
  const base = prefix.split(' ')[0] ?? ''

  if ((base === 'grep' || base === 'rg' || base === 'egrep' || base === 'fgrep') && exitCode === 1 && !stderr.trim()) {
    return { isError: false, message: 'No matches found' }
  }

  if (base === 'diff' && exitCode === 1 && stdout.length > 0 && !stderr.trim()) {
    return { isError: false, message: 'Files differ' }
  }

  if (base === 'test' || base === '[') {
    if (exitCode === 1) {
      return { isError: false, message: 'Condition evaluated to false' }
    }
  }

  return { isError: true }
}
