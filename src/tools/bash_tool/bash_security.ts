/**
 * Defense-in-depth Bash security validation combining fail-closed AST analysis
 * (`parseForSecurityFromAst`) with 23 legacy/heuristic security checks covering
 * command substitution, process substitution, parameter/arithmetic expansion,
 * `$IFS` injection, `/proc/<pid>/environ`, Zsh builtins/expansions, obfuscated
 * whitespace/control chars, brace expansion, jq `system()`, and redirections.
 */

import {
  isSafeQuotedCatHeredocSubstitution,
  parseForSecurityFromAst,
} from '../../utilities/bash/ast.js'
import { splitCommand } from '../../utilities/bash/commands.js'
import { MAX_COMMAND_LENGTH } from '../../utilities/bash/parser.js'
import { hasActualOperatorNodes } from '../../utilities/bash/tree_sitter_analysis.js'
import { checkSedConstraints } from './sed_validation.js'

export const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  JQ_FILE_ARGUMENTS: 3,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  NEWLINES: 7,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,
  IFS_INJECTION: 11,
  GIT_COMMIT_SUBSTITUTION: 12,
  PROC_ENVIRON_ACCESS: 13,
  MALFORMED_TOKEN_INJECTION: 14,
  BACKSLASH_ESCAPED_WHITESPACE: 15,
  BRACE_EXPANSION: 16,
  CONTROL_CHARACTERS: 17,
  UNICODE_WHITESPACE: 18,
  MID_WORD_HASH: 19,
  ZSH_DANGEROUS_COMMANDS: 20,
  BACKSLASH_ESCAPED_OPERATORS: 21,
  COMMAND_LENGTH_EXCEEDED: 22,
  AST_TOO_COMPLEX: 23,
} as const

export type BashSecurityCheckId =
  (typeof BASH_SECURITY_CHECK_IDS)[keyof typeof BASH_SECURITY_CHECK_IDS]

export interface BashSecurityResult {
  behavior: 'passthrough' | 'ask'
  message?: string
  checkId?: BashSecurityCheckId
}

export const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',
  'emulate',
  'zpty',
  'ztcp',
  'zsocket',
  'mapfile',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zsystem',
  'zcompile',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
])

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/
const BACKSLASH_WHITESPACE_RE = /\\[ \t]|[^ \t\n\\]\\\n/
const IFS_INJECTION_RE = /\$IFS\b|\$\{IFS\b/
const PROC_ENVIRON_RE = /\/proc\/(?:self|\d+)\/environ\b/
const ZSH_EQUALS_RE = /(?:^|[\s;&|])=[a-zA-Z_]/
const ZSH_TILDE_BRACKET_RE = /~\[/
const BRACE_EXPANSION_RE = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/

/**
 * Strips verified safe single-quoted `$(cat <<'EOF'\n...\nEOF\n)` heredoc
 * substitutions so commit-message style heredocs don't trip substitution checks.
 */
export function stripSafeHeredocSubstitutions(command: string): string {
  const re = /\$\(\s*cat\s+<<-?\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\r?\n[\s\S]*?\r?\n\t*\1\s*\)/g
  return command.replace(re, match =>
    isSafeQuotedCatHeredocSubstitution(match) ? '__SAFE_HEREDOC__' : match,
  )
}

/**
 * Extracts text outside single quotes (where bash still interprets `$`, `` ` ``,
 * expansions) and text completely outside all quotes (where bash interprets
 * redirections, braces, operators).
 */
export function extractUnquotedViews(command: string): {
  outsideSingleQuotes: string
  completelyUnquoted: string
  hasUnbalancedQuotes: boolean
} {
  let outsideSingle = ''
  let unquoted = ''
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (inSingle) {
      if (ch === "'") {
        inSingle = false
        outsideSingle += ' '
        unquoted += ' '
      }
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      if (inDouble) {
        outsideSingle += ch + command[i + 1]!
      } else {
        outsideSingle += ch + command[i + 1]!
        unquoted += ch + command[i + 1]!
      }
      i++
      continue
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false
        outsideSingle += ' '
        unquoted += ' '
      } else {
        outsideSingle += ch
      }
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    outsideSingle += ch
    unquoted += ch
  }

  return {
    outsideSingleQuotes: outsideSingle,
    completelyUnquoted: unquoted,
    hasUnbalancedQuotes: inSingle || inDouble,
  }
}

/**
 * Removes safe fd redirections (`2>&1`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`)
 * before checking for arbitrary file redirections.
 */
export function stripSafeRedirections(unquoted: string): string {
  return unquoted
    .replace(/\b[0-9]*>&[0-9]+\b/g, '')
    .replace(/(?:&|[0-9]*)>>?\s*\/dev\/null\b/g, '')
}

function checkJqDangerousUsage(command: string): BashSecurityResult | null {
  const trimmed = command.trim()
  if (!/(?:^|[;&|]\s*)jq\b/.test(trimmed)) {
    return null
  }
  if (/\bsystem\s*\(/.test(trimmed)) {
    return {
      behavior: 'ask',
      message: 'jq command contains system() call which can execute arbitrary commands',
      checkId: BASH_SECURITY_CHECK_IDS.JQ_SYSTEM_FUNCTION,
    }
  }
  if (/\s(?:--argfile|--rawfile|--slurpfile|--from-file|-f)(?:\s|=)/.test(trimmed)) {
    return {
      behavior: 'ask',
      message: 'jq command reads external files via --argfile/--rawfile/-f',
      checkId: BASH_SECURITY_CHECK_IDS.JQ_FILE_ARGUMENTS,
    }
  }
  return null
}

/**
 * Synchronous legacy heuristic security validator for Bash commands.
 */
export function bashCommandIsSafe(command: string): BashSecurityResult {
  if (command.length > MAX_COMMAND_LENGTH) {
    return {
      behavior: 'ask',
      message: `Command length (${command.length}) exceeds maximum safe analysis limit (${MAX_COMMAND_LENGTH})`,
      checkId: BASH_SECURITY_CHECK_IDS.COMMAND_LENGTH_EXCEEDED,
    }
  }

  if (CONTROL_CHAR_RE.test(command)) {
    return {
      behavior: 'ask',
      message: 'Command contains ASCII control characters',
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    }
  }

  if (UNICODE_WHITESPACE_RE.test(command)) {
    return {
      behavior: 'ask',
      message: 'Command contains invisible Unicode whitespace characters',
      checkId: BASH_SECURITY_CHECK_IDS.UNICODE_WHITESPACE,
    }
  }

  const sanitized = stripSafeHeredocSubstitutions(command)
  const { outsideSingleQuotes, completelyUnquoted, hasUnbalancedQuotes } =
    extractUnquotedViews(sanitized)

  if (hasUnbalancedQuotes) {
    return {
      behavior: 'ask',
      message: 'Command contains unbalanced quotes',
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
    }
  }

  if (BACKSLASH_WHITESPACE_RE.test(completelyUnquoted)) {
    return {
      behavior: 'ask',
      message: 'Command contains backslash-escaped whitespace or mid-word line continuation',
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_WHITESPACE,
    }
  }

  // Command substitution & process substitution & parameter/arithmetic expansion
  if (
    /\$\(/.test(outsideSingleQuotes) ||
    /`/.test(outsideSingleQuotes) ||
    /<\(/.test(completelyUnquoted) ||
    />\(/.test(completelyUnquoted) ||
    /\$\{/.test(outsideSingleQuotes) ||
    /\$\[/.test(outsideSingleQuotes)
  ) {
    return {
      behavior: 'ask',
      message: 'Command contains command/process substitution or parameter expansion',
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION,
    }
  }

  if (IFS_INJECTION_RE.test(outsideSingleQuotes)) {
    return {
      behavior: 'ask',
      message: 'Command references $IFS which can alter word splitting',
      checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION,
    }
  }

  if (PROC_ENVIRON_RE.test(sanitized)) {
    return {
      behavior: 'ask',
      message: 'Command accesses /proc/*/environ which may expose secrets',
      checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS,
    }
  }

  if (ZSH_EQUALS_RE.test(completelyUnquoted) || ZSH_TILDE_BRACKET_RE.test(completelyUnquoted)) {
    return {
      behavior: 'ask',
      message: 'Command uses Zsh =cmd or ~[...] expansion',
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
    }
  }

  // Check Zsh dangerous commands at command position
  const firstTokens = completelyUnquoted
    .split(/[;&|\n]+/)
    .map(part => part.trim().split(/\s+/)[0] ?? '')
  for (const tok of firstTokens) {
    if (ZSH_DANGEROUS_COMMANDS.has(tok) || tok.startsWith('zf_')) {
      return {
        behavior: 'ask',
        message: `Command invokes Zsh dangerous builtin '${tok}'`,
        checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      }
    }
  }

  if (BRACE_EXPANSION_RE.test(completelyUnquoted)) {
    return {
      behavior: 'ask',
      message: 'Command contains unquoted brace expansion',
      checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
    }
  }

  const jqCheck = checkJqDangerousUsage(sanitized)
  if (jqCheck) return jqCheck

  // Check sed subcommands for dangerous execute/write/read/file-script constructs
  for (const sub of splitCommand(sanitized)) {
    const trimmedSub = sub.trim()
    if (trimmedSub === 'sed' || trimmedSub.startsWith('sed ')) {
      const sedCheck = checkSedConstraints(trimmedSub)
      if (sedCheck.behavior === 'ask') {
        return {
          behavior: 'ask',
          message: sedCheck.message,
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
        }
      }
    }
  }

  // Subshell `(...)` or brace group `{ ...; }` outside quotes
  if (/(?:^|[;&|\s])\([^)]*\)/.test(completelyUnquoted)) {
    return {
      behavior: 'ask',
      message: 'Command contains subshell grouping',
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
    }
  }

  // Output / input redirections (after stripping safe /dev/null and 2>&1)
  const strippedRedirs = stripSafeRedirections(completelyUnquoted)
  if (/(?:^|[^\\])(?:>>?|&>>?|>\||<<<?)/.test(strippedRedirs)) {
    return {
      behavior: 'ask',
      message: 'Command contains file I/O redirection',
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_OUTPUT_REDIRECTION,
    }
  }

  return { behavior: 'passthrough' }
}

/**
 * Primary async security check combining fail-closed `tree-sitter-bash` AST
 * analysis (`parseForSecurityFromAst`) with defense-in-depth legacy checks.
 */
export async function bashCommandIsSafeAsync(
  command: string,
): Promise<BashSecurityResult> {
  if (command.length > MAX_COMMAND_LENGTH) {
    return {
      behavior: 'ask',
      message: `Command length (${command.length}) exceeds maximum safe analysis limit (${MAX_COMMAND_LENGTH})`,
      checkId: BASH_SECURITY_CHECK_IDS.COMMAND_LENGTH_EXCEEDED,
    }
  }

  // 1. Fail-closed AST check first
  const astResult = await parseForSecurityFromAst(command)
  if (astResult.kind === 'too-complex') {
    return {
      behavior: 'ask',
      message: astResult.reason,
      checkId: BASH_SECURITY_CHECK_IDS.AST_TOO_COMPLEX,
    }
  }

  // 2. Check legacy heuristics (using AST operator awareness to avoid false positives on `find -exec \;`)
  const legacy = bashCommandIsSafe(command)
  if (legacy.behavior === 'ask') {
    // Allow safe redirections that only target `/dev/null` or fd dupes when AST parsed cleanly
    if (
      legacy.checkId ===
        BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_OUTPUT_REDIRECTION &&
      astResult.kind === 'simple'
    ) {
      const hasUnsafeRedirect = astResult.commands.some(cmd =>
        cmd.redirects.some(
          r =>
            r.target !== '/dev/null' &&
            !(r.op === '>&' && /^\d+$/.test(r.target)),
        ),
      )
      if (!hasUnsafeRedirect) {
        return { behavior: 'passthrough' }
      }
    }
    return legacy
  }

  // Verify backslash-escaped operator sanity via AST
  if (/\\[;&|]/.test(command)) {
    const hasOps = await hasActualOperatorNodes(command)
    if (hasOps === null) {
      return {
        behavior: 'ask',
        message: 'Could not verify escaped shell operators via AST',
        checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_OPERATORS,
      }
    }
  }

  return { behavior: 'passthrough' }
}

export const bashCommandIsSafe_DEPRECATED = bashCommandIsSafe
export const bashCommandIsSafeAsync_DEPRECATED = bashCommandIsSafeAsync
