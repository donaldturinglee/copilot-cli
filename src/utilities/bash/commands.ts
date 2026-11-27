/**
 * Compound Bash command splitting, output redirection extraction, and
 * subcommand prefix extraction.
 */

import { parseSource } from './bash_parser.js'

export interface OutputRedirection {
  target: string
  operator: '>' | '>>' | '>|' | '&>' | '&>>'
  fd?: number
}

const MAX_SPLIT_SUBCOMMANDS = 100

/**
 * Splits a compound Bash command into individual subcommands along unquoted
 * `&&`, `||`, `|`, `|&`, `;`, `&`, and newline boundaries while respecting
 * single quotes, double quotes, backslash escapes, and `$(...)` nesting.
 */
export function splitCommand(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return []

  const results: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let parenDepth = 0
  let i = 0

  const flush = () => {
    const part = current.trim()
    if (part) {
      results.push(part)
    }
    current = ''
  }

  while (i < trimmed.length) {
    if (results.length >= MAX_SPLIT_SUBCOMMANDS) {
      break
    }

    const ch = trimmed[i]!
    const next = trimmed[i + 1] ?? ''

    if (inSingle) {
      current += ch
      if (ch === "'") inSingle = false
      i++
      continue
    }

    if (ch === '\\' && i + 1 < trimmed.length) {
      current += ch + next
      i += 2
      continue
    }

    if (inDouble) {
      current += ch
      if (ch === '"') {
        inDouble = false
      } else if (ch === '$' && next === '(') {
        parenDepth++
        current += next
        i += 2
        continue
      }
      i++
      continue
    }

    if (ch === "'") {
      inSingle = true
      current += ch
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      current += ch
      i++
      continue
    }
    if (ch === '(') {
      parenDepth++
      current += ch
      i++
      continue
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth--
      current += ch
      i++
      continue
    }

    if (parenDepth === 0) {
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        flush()
        i += 2
        continue
      }
      if (ch === '|' && next === '&') {
        flush()
        i += 2
        continue
      }
      if (ch === '|' || ch === ';' || ch === '\n') {
        flush()
        i++
        continue
      }
      // Background `&` (but NOT `&>`, `&>>`, `>&`, `<&`)
      if (
        ch === '&' &&
        next !== '>' &&
        trimmed[i - 1] !== '>' &&
        trimmed[i - 1] !== '<'
      ) {
        flush()
        i++
        continue
      }
    }

    current += ch
    i++
  }

  flush()
  return results
}

export const splitCommand_DEPRECATED = splitCommand

const OUTPUT_REDIR_OPS = new Set(['>', '>>', '>|', '&>', '&>>'])

/**
 * Extracts file-writing output redirections from a Bash command (skipping
 * safe sinks like `/dev/null` and fd duplications like `2>&1`).
 */
export function extractOutputRedirections(command: string): {
  commandWithoutRedirections: string
  redirections: OutputRedirection[]
} {
  const redirections: OutputRedirection[] = []
  const ast = parseSource(command, 50, 50_000)

  if (!ast) {
    // Fallback regex scan when AST parser aborts
    const fallbackRe = /(?:^|[\s])(\d*)?(&>>|&>|>>|>\||>)\s*([^\s;&|<>]+)/g
    let match: RegExpExecArray | null
    while ((match = fallbackRe.exec(command)) !== null) {
      const fdRaw = match[1]
      const op = match[2] as OutputRedirection['operator']
      const target = match[3]!.replace(/^['"]|['"]$/g, '')
      if (target && target !== '/dev/null' && !target.startsWith('&')) {
        redirections.push({
          target,
          operator: op,
          ...(fdRaw ? { fd: Number.parseInt(fdRaw, 10) } : {}),
        })
      }
    }
    return { commandWithoutRedirections: command, redirections }
  }

  const redirSpans: Array<{ start: number; end: number }> = []

  const visit = (node: ReturnType<typeof parseSource>) => {
    if (!node) return
    if (node.type === 'file_redirect') {
      let fd: number | undefined
      let op: OutputRedirection['operator'] | undefined
      let target: string | undefined
      for (const child of node.children) {
        if (child.type === 'file_descriptor') {
          const parsed = Number.parseInt(child.text, 10)
          if (!Number.isNaN(parsed)) fd = parsed
        } else if (OUTPUT_REDIR_OPS.has(child.type)) {
          op = child.type as OutputRedirection['operator']
        } else if (child.type !== '>&' && child.type !== '<&' && child.type !== '<') {
          target = child.text.replace(/^['"]|['"]$/g, '')
        }
      }
      if (op && target) {
        redirSpans.push({ start: node.startIndex, end: node.endIndex })
        if (target !== '/dev/null' && !target.startsWith('&')) {
          redirections.push({
            target,
            operator: op,
            ...(fd !== undefined ? { fd } : {}),
          })
        }
      }
      return
    }
    for (const child of node.children) {
      visit(child)
    }
  }

  visit(ast)

  if (redirSpans.length === 0) {
    return { commandWithoutRedirections: command, redirections }
  }

  redirSpans.sort((a, b) => b.start - a.start)
  let stripped = command
  for (const span of redirSpans) {
    stripped = stripped.slice(0, span.start) + stripped.slice(span.end)
  }

  return {
    commandWithoutRedirections: stripped.replace(/\s+/g, ' ').trim(),
    redirections,
  }
}

export interface CommandPrefixResult {
  commandPrefix: string | null
}

export function getCommandSubcommandPrefix(command: string): CommandPrefixResult {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  let idx = 0
  while (idx < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[idx]!)) {
    idx++
  }
  const rest = tokens.slice(idx)
  if (rest.length === 0) return { commandPrefix: null }
  if (
    rest.length >= 2 &&
    /^[a-z][a-z0-9-]*$/.test(rest[0]!) &&
    /^[a-z][a-z0-9-]*$/.test(rest[1]!)
  ) {
    return { commandPrefix: `${rest[0]} ${rest[1]}` }
  }
  return { commandPrefix: rest[0] ?? null }
}
