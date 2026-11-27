/**
 * POSIX/Windows shell quoting, stdin redirection checks, and Windows null-device
 * normalization helpers.
 */

/**
 * Single-quotes a string safely for POSIX shells (`bash`/`sh`/`zsh`).
 */
export function quoteShellCommand(command: string): string {
  return `'${command.replace(/'/g, "'\\''")}'`
}

/**
 * Checks whether a command already includes an explicit stdin redirection
 * (`<`, `<<`, `<<<`) outside quotes.
 */
export function hasStdinRedirect(command: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (ch === '\\' && !inSingle) {
      i++
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble && ch === '<') {
      return true
    }
  }
  return false
}

/**
 * Returns true if `< /dev/null` should be appended to prevent interactive tools
 * from blocking on stdin.
 */
export function shouldAddStdinRedirect(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (hasStdinRedirect(trimmed)) return false
  // Avoid breaking heredocs or background ampersands at line end
  if (trimmed.endsWith('&') && !trimmed.endsWith('&&')) return false
  return true
}

/**
 * Rewrites `/dev/null` redirections to Windows `NUL` when targeting `cmd.exe`
 * or Windows PowerShell (not needed inside Git Bash/MSYS).
 */
export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(/(^|[\s>&])\/dev\/null\b/g, '$1NUL')
}
