/**
 * Command prefix extraction helpers for permission rule display and analytics.
 */

const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Extracts the leading command executable (or two-token subcommand such as
 * `git status`, `npm test`) from a shell command string.
 */
export function extractCommandPrefix(command: string): string {
  const firstSegment = command.split(/(?:&&|\|\||[;|\n])/)[0]?.trim() ?? ''
  if (!firstSegment) return ''
  const tokens = firstSegment.split(/\s+/).filter(Boolean)
  let idx = 0
  while (idx < tokens.length && ENV_ASSIGNMENT_REGEX.test(tokens[idx]!)) {
    idx++
  }
  const exe = tokens[idx]
  if (!exe) return ''
  const next = tokens[idx + 1]
  if (
    next &&
    !next.startsWith('-') &&
    (exe === 'git' ||
      exe === 'npm' ||
      exe === 'bun' ||
      exe === 'yarn' ||
      exe === 'pnpm' ||
      exe === 'cargo' ||
      exe === 'docker' ||
      exe === 'kubectl' ||
      exe === 'gh')
  ) {
    return `${exe} ${next}`
  }
  return exe
}
