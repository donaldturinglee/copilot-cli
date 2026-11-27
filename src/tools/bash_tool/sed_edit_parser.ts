/**
 * Parser for `sed` CLI arguments and script expressions to distinguish
 * read-only printing/filtering from in-place edits (`-i`) or arbitrary code
 * execution (`e`, `w`, `r`, `-f`).
 */

import { tryParseShellCommand } from '../../utilities/bash/shell_quote.js'

export interface ParsedSedCommand {
  valid: boolean
  inPlace: boolean
  hasDangerousFlag: boolean
  dangerousReason?: string
  scripts: string[]
  files: string[]
  quiet: boolean
}

const SAFE_NO_ARG_FLAGS = new Set([
  '-n',
  '--quiet',
  '--silent',
  '-E',
  '-r',
  '--regexp-extended',
  '--posix',
  '-s',
  '--separate',
  '-u',
  '--unbuffered',
  '-z',
  '--zero-terminated',
])

export function parseSedCommand(rawCommand: string): ParsedSedCommand {
  const parsed = tryParseShellCommand(rawCommand)
  if (!parsed.success || parsed.tokens.length === 0) {
    return {
      valid: false,
      inPlace: false,
      hasDangerousFlag: true,
      dangerousReason: 'Could not tokenize sed command',
      scripts: [],
      files: [],
      quiet: false,
    }
  }

  const tokens = parsed.tokens.filter((t): t is string => typeof t === 'string')
  if (tokens[0] !== 'sed') {
    return {
      valid: false,
      inPlace: false,
      hasDangerousFlag: true,
      dangerousReason: 'Not a sed command',
      scripts: [],
      files: [],
      quiet: false,
    }
  }

  let inPlace = false
  let quiet = false
  const scripts: string[] = []
  const files: string[] = []
  let endOfFlags = false

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!

    if (!endOfFlags && tok === '--') {
      endOfFlags = true
      continue
    }

    if (!endOfFlags && tok.startsWith('-')) {
      if (tok === '-i' || tok.startsWith('-i') || tok === '--in-place' || tok.startsWith('--in-place=')) {
        inPlace = true
        continue
      }
      if (tok === '-f' || tok === '--file' || tok.startsWith('--file=') || /^-.*f/.test(tok)) {
        return {
          valid: true,
          inPlace,
          hasDangerousFlag: true,
          dangerousReason: 'sed -f/--file reads script from external file',
          scripts,
          files,
          quiet,
        }
      }
      if (tok === '-e' || tok === '--expression') {
        const expr = tokens[i + 1]
        if (expr === undefined) {
          return {
            valid: false,
            inPlace,
            hasDangerousFlag: true,
            dangerousReason: 'Missing sed expression after -e',
            scripts,
            files,
            quiet,
          }
        }
        scripts.push(expr)
        i++
        continue
      }
      if (tok.startsWith('--expression=')) {
        scripts.push(tok.slice('--expression='.length))
        continue
      }
      if (tok === '-l' || tok === '--line-length') {
        i++
        continue
      }
      if (SAFE_NO_ARG_FLAGS.has(tok)) {
        if (tok === '-n' || tok === '--quiet' || tok === '--silent') {
          quiet = true
        }
        continue
      }
      // Bundled short flags like `-nE` or `-rn`
      if (/^-[nErsuz]+$/.test(tok)) {
        if (tok.includes('n')) quiet = true
        continue
      }
      return {
        valid: true,
        inPlace,
        hasDangerousFlag: true,
        dangerousReason: `Unsupported sed flag: ${tok}`,
        scripts,
        files,
        quiet,
      }
    }

    if (scripts.length === 0) {
      scripts.push(tok)
    } else {
      files.push(tok)
    }
  }

  return {
    valid: true,
    inPlace,
    hasDangerousFlag: false,
    scripts,
    files,
    quiet,
  }
}
