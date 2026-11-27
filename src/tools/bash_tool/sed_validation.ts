/**
 * Security validator for `sed` commands.
 * Allows read-only printing/filtering scripts (`sed -n '1,20p' file.ts`) while
 * strictly rejecting `-i` in-place mutations and dangerous sed script commands
 * (`e` shell execution, `w`/`W` file write, `r`/`R` file read, `s///e` / `s///w`).
 */

import { parseSedCommand } from './sed_edit_parser.js'

// Matches safe read-only print ranges like `1,50p`, `10p`, `$p`, `1,20p;21q`, `/foo/p`
const SAFE_PRINT_EXPRESSION_RE =
  /^(?:\s*(?:\d+|\$|\/[^/\\]*(?:\\.[^/\\]*)*\/)(?:\s*,\s*(?:\d+|\$|\+\d+|\/[^/\\]*(?:\\.[^/\\]*)*\/))?\s*[pqd=]\s*;?)+$/

function isSedScriptReadOnlySafe(script: string): boolean {
  const trimmed = script.trim()
  if (!trimmed) return false

  // Fast path: strict line-range print/quit/delete expressions
  if (SAFE_PRINT_EXPRESSION_RE.test(trimmed)) {
    return true
  }

  // Check substitution `s<delim>pat<delim>rep<delim><flags>`: block `e` and `w` flags!
  const subMatch = trimmed.match(/^s([^\s\\])/)
  if (subMatch) {
    const delim = subMatch[1]!
    let sepCount = 0
    let lastSepIdx = -1
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === '\\') {
        i++
        continue
      }
      if (trimmed[i] === delim) {
        sepCount++
        lastSepIdx = i
      }
    }
    if (sepCount === 3 && lastSepIdx !== -1) {
      const flags = trimmed.slice(lastSepIdx + 1)
      // Only allow safe substitution flags: g, i, I, p, digits
      if (/^[giIp0-9]*$/.test(flags)) {
        return true
      }
    }
    return false
  }

  // Reject any script containing dangerous sed commands: `e`, `w`, `W`, `r`, `R`
  // Fail closed on unrecognized complex scripts
  return false
}

/**
 * Returns `true` ONLY if the `sed` invocation is provably read-only (no `-i`,
 * no `-f`, no `e`/`w`/`W`/`r`/`R` commands or flags).
 */
export function sedCommandIsAllowedByAllowlist(rawCommand: string): boolean {
  const parsed = parseSedCommand(rawCommand)
  if (!parsed.valid || parsed.inPlace || parsed.hasDangerousFlag) {
    return false
  }
  if (parsed.scripts.length === 0) {
    return false
  }
  return parsed.scripts.every(isSedScriptReadOnlySafe)
}

export function checkSedConstraints(rawCommand: string): {
  behavior: 'passthrough' | 'ask'
  message?: string
} {
  const parsed = parseSedCommand(rawCommand)
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: parsed.dangerousReason ?? 'Unparseable sed command',
    }
  }
  if (parsed.hasDangerousFlag) {
    return {
      behavior: 'ask',
      message: parsed.dangerousReason ?? 'Dangerous sed flag requires confirmation',
    }
  }
  // Check for `e` (exec) or `w` (write) inside any script even for non-read-only sed
  for (const script of parsed.scripts) {
    if (/(?:^|[;{}])\s*(?:\d+(?:,\d+)?\s*)?[eEwWrR]\b/.test(script)) {
      return {
        behavior: 'ask',
        message: 'sed script contains execute (e), write (w), or read (r) command',
      }
    }
    // Check `s///e` or `s///w file`
    if (/^s([^\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[^\s;]*[eEwW]/.test(script.trim())) {
      return {
        behavior: 'ask',
        message: 'sed substitution uses execute (e) or write (w) flag',
      }
    }
  }
  return { behavior: 'passthrough' }
}
