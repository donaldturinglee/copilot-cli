/**
 * Hardened wrapper around `shell-quote` with malformed-token and single-quote
 * edge-case detection.
 */

import {
  parse as rawParse,
  quote as rawQuote,
  type ParseEntry,
} from 'shell-quote'

export type ShellToken = ParseEntry

/**
 * Detects known `shell-quote` single-quote / backslash edge cases where
 * parsing can diverge from real POSIX shell tokenization.
 */
export function hasShellQuoteSingleQuoteBug(command: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === '\\' && inSingle) {
      return true
    }
  }
  return false
}

/**
 * Checks whether parsed tokens contain comments or unrecognized structures.
 */
export function hasMalformedTokens(tokens: readonly ShellToken[]): boolean {
  return tokens.some(tok => typeof tok === 'object' && tok !== null && 'comment' in tok)
}

/**
 * Attempts to tokenize a shell command with `shell-quote`, returning
 * `{ success: false }` on parse error.
 */
export function tryParseShellCommand(
  command: string,
  envVars?: Record<string, string>,
): { success: true; tokens: ShellToken[] } | { success: false; error: string } {
  try {
    const tokens = rawParse(command, envVars)
    return { success: true, tokens }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Quotes an array of argument strings safely for POSIX shell execution.
 */
export function quote(args: readonly string[]): string {
  return rawQuote([...args])
}
