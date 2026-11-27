/**
 * Fail-closed AST security walker for Bash commands (`parseForSecurityFromAst`).
 *
 * Explicit node allowlist design:
 * - If the parser returns `PARSE_ABORTED`, contains `ERROR` nodes, or hits any
 *   unallowlisted shell construct (command substitution, process substitution,
 *   parameter expansion `${...}`, arithmetic expansion `$((...))`, subshells,
 *   loops/conditionals, eval-like builtins, Zsh `=cmd` / `~[`, control chars,
 *   Unicode whitespace, backslash-whitespace differentials, unquoted `$VAR`,
 *   brace expansion `{a,b}`), it returns `{ kind: 'too-complex', reason }`,
 *   forcing the permission system to ask the user.
 * - Safe quoted heredoc pattern `$(cat <<'EOF'\n...\nEOF\n)` (commonly used for
 *   multi-line git commit messages) is explicitly recognized and represented as
 *   a safe placeholder so legitimate commits aren't misclassified.
 */

import type { Node } from './parser.js'
import { PARSE_ABORTED, parseCommandRaw } from './parser.js'

export interface Redirect {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}

export interface SimpleCommand {
  argv: string[]
  envVars: Array<{ name: string; value: string }>
  redirects: Redirect[]
  text: string
}

export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

const STRUCTURAL_TYPES = new Set([
  'program',
  'list',
  'pipeline',
  'redirected_statement',
])

const SEPARATOR_TYPES = new Set(['&&', '||', '|', ';', '&', '|&', '\n', 'comment'])

const DANGEROUS_TYPES = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'arithmetic_expansion',
  'brace_expression',
  'subshell',
  'compound_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'test_command',
  'ansi_c_string',
  'translated_string',
  'herestring_redirect',
  'heredoc_redirect',
])

const DANGEROUS_TYPE_IDS = [...DANGEROUS_TYPES]

export function nodeTypeId(nodeType: string | undefined): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const idx = DANGEROUS_TYPE_IDS.indexOf(nodeType)
  return idx >= 0 ? idx + 1 : 0
}

/**
 * Builtins / shell meta-commands that dynamically evaluate strings, alter shell
 * execution semantics, load native modules, or invoke commands indirectly.
 */
export const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'exec',
  'source',
  '.',
  'trap',
  'enable',
  'hash',
  'builtin',
  'command',
  'compgen',
  'complete',
  'fc',
  'bind',
  'coproc',
  'mapfile',
  'readarray',
  // Zsh dangerous builtins/modules
  'zmodload',
  'emulate',
  'zpty',
  'ztcp',
  'zsocket',
  'zcompile',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zsystem',
])

const SAFE_ENV_VARS_IN_QUOTES = new Set([
  'HOME',
  'PWD',
  'OLDPWD',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'HOSTNAME',
  'UID',
  'EUID',
  'PPID',
  'RANDOM',
  'SECONDS',
  'LINENO',
  'TMPDIR',
  'BASH_VERSION',
  'BASHPID',
  'SHLVL',
])

const SPECIAL_VARS_IN_QUOTES = new Set(['?', '$', '!', '#', '0', '-'])

const REDIRECT_OPS: Readonly<Record<string, Redirect['op']>> = {
  '>': '>',
  '>>': '>>',
  '<': '<',
  '>&': '>&',
  '<&': '<&',
  '>|': '>|',
  '&>': '&>',
  '&>>': '&>>',
  '<<<': '<<<',
  '<<': '<<',
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/
const BACKSLASH_WHITESPACE_RE = /\\[ \t]|[^ \t\n\\]\\\n/
const ZSH_TILDE_BRACKET_RE = /~\[/
const ZSH_EQUALS_EXPANSION_RE = /(?:^|[\s;&|])=[a-zA-Z_]/
const BRACE_EXPANSION_RE = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/

/**
 * Matches a strictly single-quoted `cat` heredoc substitution:
 * `$(cat <<'EOF'\n...\nEOF\n)` (with optional `<<-'EOF'`).
 * Because the delimiter is single-quoted, Bash performs ZERO parameter,
 * command, or arithmetic expansion inside the heredoc body.
 */
const SAFE_QUOTED_CAT_HEREDOC_RE =
  /^\$\(\s*cat\s+<<-?\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\r?\n[\s\S]*?\r?\n\t*\1\s*\)$/

export function isSafeQuotedCatHeredocSubstitution(text: string): boolean {
  const match = text.match(SAFE_QUOTED_CAT_HEREDOC_RE)
  if (!match) return false
  const delim = match[1]!
  // Ensure the delimiter does not appear prematurely followed by extra commands
  const firstNl = text.indexOf('\n')
  const bodyAndEnd = text.slice(firstNl + 1, -1) // strip trailing `)`
  const lines = bodyAndEnd.split(/\r?\n/)
  let closingLineIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.replace(/^\t+/, '') === delim) {
      closingLineIdx = i
      break
    }
  }
  if (closingLineIdx === -1) return false
  // Nothing non-whitespace may appear after the closing delimiter inside `$(...)`
  for (let i = closingLineIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) {
      return false
    }
  }
  return true
}

function unescapeWord(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      out += raw[i + 1]!
      i++
      continue
    }
    out += raw[i]!
  }
  return out
}

function resolveArgumentNode(
  node: Node,
  insideDoubleQuote: boolean,
): { ok: true; value: string } | { ok: false; reason: string; nodeType: string } {
  switch (node.type) {
    case 'word':
    case 'number': {
      if (!insideDoubleQuote) {
        if (BRACE_EXPANSION_RE.test(node.text)) {
          return {
            ok: false,
            reason: 'Unquoted brace expansion cannot be statically analyzed',
            nodeType: 'brace_expression',
          }
        }
        if (ZSH_TILDE_BRACKET_RE.test(node.text)) {
          return {
            ok: false,
            reason: 'Zsh dynamic named directory expansion (~[...]) detected',
            nodeType: 'word',
          }
        }
      }
      return { ok: true, value: unescapeWord(node.text) }
    }

    case 'raw_string': {
      return { ok: true, value: node.text.slice(1, -1) }
    }

    case 'string_content': {
      return { ok: true, value: node.text }
    }

    case 'string': {
      let combined = ''
      for (const child of node.children) {
        const res = resolveArgumentNode(child, true)
        if (!res.ok) return res
        combined += res.value
      }
      return { ok: true, value: combined }
    }

    case 'concatenation': {
      let combined = ''
      for (const child of node.children) {
        const res = resolveArgumentNode(child, insideDoubleQuote)
        if (!res.ok) return res
        combined += res.value
      }
      return { ok: true, value: combined }
    }

    case 'command_substitution': {
      if (isSafeQuotedCatHeredocSubstitution(node.text)) {
        return { ok: true, value: '__SAFE_HEREDOC_CONTENT__' }
      }
      return {
        ok: false,
        reason: 'Command substitution ($() or backticks) requires explicit approval',
        nodeType: 'command_substitution',
      }
    }

    case 'simple_expansion': {
      if (!insideDoubleQuote) {
        return {
          ok: false,
          reason: `Unquoted variable expansion (${node.text}) is subject to word-splitting/globbing`,
          nodeType: 'simple_expansion',
        }
      }
      const varChild = node.children[0]
      if (!varChild) {
        return {
          ok: false,
          reason: 'Malformed variable expansion',
          nodeType: 'simple_expansion',
        }
      }
      if (
        (varChild.type === 'variable_name' &&
          SAFE_ENV_VARS_IN_QUOTES.has(varChild.text)) ||
        (varChild.type === 'special_variable_name' &&
          SPECIAL_VARS_IN_QUOTES.has(varChild.text))
      ) {
        return { ok: true, value: `__VAR_${varChild.text}__` }
      }
      return {
        ok: false,
        reason: `Dynamic variable expansion (${node.text}) requires confirmation`,
        nodeType: 'simple_expansion',
      }
    }

    case 'ERROR':
      return {
        ok: false,
        reason: 'Malformed Bash syntax (AST ERROR node)',
        nodeType: 'ERROR',
      }

    default:
      return {
        ok: false,
        reason: `Unsupported or dangerous Bash AST node: ${node.type}`,
        nodeType: node.type,
      }
  }
}

function extractRedirect(
  redirNode: Node,
): { ok: true; redirect: Redirect } | { ok: false; reason: string; nodeType: string } {
  if (redirNode.type !== 'file_redirect') {
    return {
      ok: false,
      reason: `Unsupported redirect type: ${redirNode.type}`,
      nodeType: redirNode.type,
    }
  }

  let fd: number | undefined
  let op: Redirect['op'] | undefined
  let target: string | undefined

  for (const child of redirNode.children) {
    if (child.type === 'file_descriptor') {
      const parsedFd = Number.parseInt(child.text, 10)
      if (!Number.isNaN(parsedFd)) fd = parsedFd
    } else if (child.type in REDIRECT_OPS) {
      op = REDIRECT_OPS[child.type]
    } else {
      const resolved = resolveArgumentNode(child, false)
      if (!resolved.ok) return resolved
      target = resolved.value
    }
  }

  if (!op || target === undefined) {
    return {
      ok: false,
      reason: 'Incomplete file redirection in Bash command',
      nodeType: 'file_redirect',
    }
  }

  return {
    ok: true,
    redirect: { op, target, ...(fd !== undefined ? { fd } : {}) },
  }
}

function walkCommandNode(
  cmdNode: Node,
  extraRedirects: readonly Redirect[],
): { ok: true; command: SimpleCommand } | { ok: false; reason: string; nodeType?: string } {
  if (cmdNode.type === 'declaration_command') {
    return {
      ok: false,
      reason: 'Shell declaration command modifies shell environment',
      nodeType: 'declaration_command',
    }
  }

  const argv: string[] = []
  const envVars: Array<{ name: string; value: string }> = []
  const redirects: Redirect[] = [...extraRedirects]

  for (const child of cmdNode.children) {
    if (child.type === 'variable_assignment') {
      const eqIdx = child.text.indexOf('=')
      const name = eqIdx === -1 ? child.text : child.text.slice(0, eqIdx)
      const valRaw = eqIdx === -1 ? '' : child.text.slice(eqIdx + 1)
      // Reject command substitution or expansion inside env var value
      for (const sub of child.children) {
        if (DANGEROUS_TYPES.has(sub.type) || sub.type === 'ERROR') {
          return {
            ok: false,
            reason: `Dynamic expression in environment assignment ${name}`,
            nodeType: sub.type,
          }
        }
      }
      envVars.push({ name, value: valRaw })
      continue
    }

    if (child.type === 'command_name') {
      const inner = child.children[0]
      if (!inner) {
        return {
          ok: false,
          reason: 'Empty command_name node',
          nodeType: 'command_name',
        }
      }
      const resolved = resolveArgumentNode(inner, false)
      if (!resolved.ok) return resolved
      argv.push(resolved.value)
      continue
    }

    if (child.type === 'file_redirect') {
      const r = extractRedirect(child)
      if (!r.ok) return r
      redirects.push(r.redirect)
      continue
    }

    const resolved = resolveArgumentNode(child, false)
    if (!resolved.ok) return resolved
    argv.push(resolved.value)
  }

  if (argv.length === 0) {
    return {
      ok: false,
      reason: 'Standalone variable assignment without executable command',
      nodeType: 'variable_assignment',
    }
  }

  const baseCmd = argv[0]!.split('/').pop() ?? argv[0]!
  if (
    EVAL_LIKE_BUILTINS.has(baseCmd) ||
    baseCmd.startsWith('zf_')
  ) {
    return {
      ok: false,
      reason: `Eval-like or shell-modifying builtin '${baseCmd}' requires confirmation`,
      nodeType: 'command',
    }
  }

  return {
    ok: true,
    command: {
      argv,
      envVars,
      redirects,
      text: cmdNode.text,
    },
  }
}

function walkNode(
  node: Node,
  out: SimpleCommand[],
): { ok: true } | { ok: false; reason: string; nodeType?: string } {
  if (node.type === 'ERROR') {
    return {
      ok: false,
      reason: 'Malformed Bash syntax (AST ERROR node)',
      nodeType: 'ERROR',
    }
  }

  if (SEPARATOR_TYPES.has(node.type)) {
    return { ok: true }
  }

  if (node.type === 'redirected_statement') {
    const redirects: Redirect[] = []
    let innerCmd: Node | null = null
    for (const child of node.children) {
      if (child.type === 'file_redirect') {
        const r = extractRedirect(child)
        if (!r.ok) return r
        redirects.push(r.redirect)
      } else if (child.type === 'command') {
        innerCmd = child
      } else {
        return {
          ok: false,
          reason: `Unsupported redirected construct: ${child.type}`,
          nodeType: child.type,
        }
      }
    }
    if (!innerCmd) {
      return {
        ok: false,
        reason: 'Redirect without simple command',
        nodeType: 'redirected_statement',
      }
    }
    const res = walkCommandNode(innerCmd, redirects)
    if (!res.ok) return res
    out.push(res.command)
    return { ok: true }
  }

  if (node.type === 'command' || node.type === 'declaration_command') {
    const res = walkCommandNode(node, [])
    if (!res.ok) return res
    out.push(res.command)
    return { ok: true }
  }

  if (STRUCTURAL_TYPES.has(node.type)) {
    for (const child of node.children) {
      const res = walkNode(child, out)
      if (!res.ok) return res
    }
    return { ok: true }
  }

  return {
    ok: false,
    reason: `Complex Bash AST construct '${node.type}' requires user approval`,
    nodeType: node.type,
  }
}

/**
 * Parses and validates a Bash command via the fail-closed AST allowlist walker.
 */
export async function parseForSecurityFromAst(
  command: string,
  options?: { timeoutMs?: number; maxNodes?: number },
): Promise<ParseForSecurityResult> {
  // Pre-checks for characters that create shell/parser differentials
  if (CONTROL_CHAR_RE.test(command)) {
    return {
      kind: 'too-complex',
      reason: 'Command contains ASCII control characters',
    }
  }
  if (UNICODE_WHITESPACE_RE.test(command)) {
    return {
      kind: 'too-complex',
      reason: 'Command contains invisible Unicode whitespace characters',
    }
  }
  if (BACKSLASH_WHITESPACE_RE.test(command)) {
    return {
      kind: 'too-complex',
      reason: 'Command contains backslash-escaped whitespace or mid-word line continuation',
    }
  }
  if (ZSH_EQUALS_EXPANSION_RE.test(command)) {
    return {
      kind: 'too-complex',
      reason: 'Command contains Zsh =cmd path expansion',
    }
  }

  const root = await parseCommandRaw(command, options)
  if (root === PARSE_ABORTED) {
    return {
      kind: 'too-complex',
      reason: 'Bash AST parser aborted (command length, timeout, or node budget exceeded)',
    }
  }
  if (root === null) {
    return { kind: 'parse-unavailable' }
  }

  const commands: SimpleCommand[] = []
  const walked = walkNode(root, commands)
  if (!walked.ok) {
    return {
      kind: 'too-complex',
      reason: walked.reason,
      nodeType: walked.nodeType,
    }
  }

  if (commands.length === 0) {
    return {
      kind: 'too-complex',
      reason: 'No executable commands extracted from Bash AST',
    }
  }

  return { kind: 'simple', commands }
}

/**
 * Checks whether a simple command passes AST semantic safety (no unexpected
 * hidden shells or obfuscated exec wrappers).
 */
export function checkSemantics(commands: readonly SimpleCommand[]): {
  safe: boolean
  reason?: string
} {
  for (const cmd of commands) {
    const first = cmd.argv[0]
    if (!first) {
      return { safe: false, reason: 'Empty command argv' }
    }
    const base = first.split('/').pop() ?? first
    if (EVAL_LIKE_BUILTINS.has(base)) {
      return {
        safe: false,
        reason: `Eval-like builtin '${base}' requires confirmation`,
      }
    }
  }
  return { safe: true }
}
