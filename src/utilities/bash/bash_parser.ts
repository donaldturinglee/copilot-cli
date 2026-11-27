/**
 * Pure-TypeScript fail-closed Bash AST parser producing `tree-sitter-bash`-compatible
 * `TsNode` trees without native/WASM binary dependencies.
 *
 * Security budgets (strictly enforced; returns `null` on budget exhaustion so
 * callers treat the command as `PARSE_ABORTED` / fail-closed):
 * - Wall-clock cap: `PARSE_TIMEOUT_MS = 50` ms
 * - Node count cap: `MAX_NODES = 50_000` nodes
 */

export interface TsNode {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: TsNode[]
}

export interface ParserModule {
  parse: (source: string, timeoutMs?: number, maxNodes?: number) => TsNode | null
}

export const PARSE_TIMEOUT_MS = 50
export const MAX_NODES = 50_000

export const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
])

const DECLARATION_KEYWORDS = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'unset',
  'unsetenv',
])

class ParseBudgetExceededError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ParseBudgetExceededError'
  }
}

interface ParserState {
  readonly src: string
  readonly len: number
  readonly deadlineMs: number
  readonly maxNodes: number
  pos: number
  nodeCount: number
  depth: number
}

const MAX_RECURSION_DEPTH = 128

function checkBudget(state: ParserState): void {
  if (state.nodeCount >= state.maxNodes) {
    throw new ParseBudgetExceededError('AST node budget exceeded')
  }
  if (
    state.deadlineMs !== Infinity &&
    (state.nodeCount & 63) === 0 &&
    Date.now() > state.deadlineMs
  ) {
    throw new ParseBudgetExceededError('AST parse timeout exceeded')
  }
}

function makeNode(
  state: ParserState,
  type: string,
  start: number,
  end: number,
  children: TsNode[] = [],
): TsNode {
  state.nodeCount++
  checkBudget(state)
  return {
    type,
    text: state.src.slice(start, end),
    startIndex: start,
    endIndex: end,
    children,
  }
}

function isHorizontalSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t'
}

function skipHorizontalSpaces(state: ParserState): void {
  while (state.pos < state.len) {
    const ch = state.src[state.pos]!
    if (isHorizontalSpace(ch)) {
      state.pos++
      continue
    }
    // Line continuation `\<LF>` preceded by whitespace
    if (ch === '\\' && state.src[state.pos + 1] === '\n') {
      state.pos += 2
      continue
    }
    break
  }
}

function skipSpacesAndNewlines(state: ParserState): void {
  while (state.pos < state.len) {
    const ch = state.src[state.pos]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      state.pos++
      continue
    }
    if (ch === '\\' && state.src[state.pos + 1] === '\n') {
      state.pos += 2
      continue
    }
    break
  }
}

function parseComment(state: ParserState): TsNode {
  const start = state.pos
  while (state.pos < state.len && state.src[state.pos] !== '\n') {
    state.pos++
  }
  return makeNode(state, 'comment', start, state.pos)
}

function parseSingleQuoted(state: ParserState): TsNode {
  const start = state.pos
  state.pos++ // skip opening '
  while (state.pos < state.len && state.src[state.pos] !== "'") {
    state.pos++
  }
  if (state.pos >= state.len) {
    return makeNode(state, 'ERROR', start, state.pos)
  }
  state.pos++ // skip closing '
  return makeNode(state, 'raw_string', start, state.pos)
}

function parseAnsiCString(state: ParserState): TsNode {
  const start = state.pos
  state.pos += 2 // skip $'
  while (state.pos < state.len) {
    const ch = state.src[state.pos]!
    if (ch === '\\' && state.pos + 1 < state.len) {
      state.pos += 2
      continue
    }
    if (ch === "'") {
      state.pos++
      return makeNode(state, 'ansi_c_string', start, state.pos)
    }
    state.pos++
  }
  return makeNode(state, 'ERROR', start, state.pos)
}

function parseBalancedDelim(
  state: ParserState,
  open: string,
  close: string,
  nodeType: string,
): TsNode {
  const start = state.pos
  state.pos += open.length
  let depth = 1
  while (state.pos < state.len && depth > 0) {
    checkBudget(state)
    const ch = state.src[state.pos]!
    if (ch === '\\' && state.pos + 1 < state.len) {
      state.pos += 2
      continue
    }
    if (ch === "'") {
      state.pos++
      while (state.pos < state.len && state.src[state.pos] !== "'") {
        state.pos++
      }
      if (state.pos < state.len) state.pos++
      continue
    }
    if (ch === '"') {
      const strNode = parseDoubleQuoted(state)
      if (strNode.type === 'ERROR') {
        return makeNode(state, 'ERROR', start, state.pos, [strNode])
      }
      continue
    }
    if (state.src.startsWith(close, state.pos)) {
      depth--
      state.pos += close.length
      if (depth === 0) break
      continue
    }
    if (open.length === 1 && ch === open) {
      depth++
      state.pos++
      continue
    }
    if (open === '$(' && state.src.startsWith('$(', state.pos)) {
      depth++
      state.pos += 2
      continue
    }
    if (open === '${' && ch === '{') {
      depth++
      state.pos++
      continue
    }
    if ((open === '<(' || open === '>(') && ch === '(') {
      depth++
      state.pos++
      continue
    }
    state.pos++
  }
  if (depth !== 0) {
    return makeNode(state, 'ERROR', start, state.pos)
  }
  return makeNode(state, nodeType, start, state.pos)
}

function parseCommandSubstitution(state: ParserState): TsNode {
  if (state.depth >= MAX_RECURSION_DEPTH) {
    throw new ParseBudgetExceededError('Max AST recursion depth exceeded')
  }
  const start = state.pos
  if (state.src.startsWith('$(', state.pos)) {
    state.pos += 2
    state.depth++
    const innerChildren: TsNode[] = []
    let closed = false
    while (state.pos < state.len) {
      checkBudget(state)
      skipSpacesAndNewlines(state)
      if (state.pos < state.len && state.src[state.pos] === ')') {
        state.pos++
        closed = true
        break
      }
      const before = state.pos
      const stmt = parseList(state, true)
      if (stmt) {
        innerChildren.push(stmt)
      }
      skipHorizontalSpaces(state)
      if (state.pos < state.len && (state.src[state.pos] === ';' || state.src[state.pos] === '\n')) {
        state.pos++
      }
      if (state.pos === before) {
        if (state.src[state.pos] === ')') {
          state.pos++
          closed = true
          break
        }
        state.pos++
      }
    }
    state.depth--
    if (!closed) {
      return makeNode(state, 'ERROR', start, state.pos, innerChildren)
    }
    return makeNode(state, 'command_substitution', start, state.pos, innerChildren)
  }

  // Backtick substitution
  state.pos++ // skip `
  while (state.pos < state.len) {
    checkBudget(state)
    const ch = state.src[state.pos]!
    if (ch === '\\' && state.pos + 1 < state.len) {
      state.pos += 2
      continue
    }
    if (ch === '`') {
      state.pos++
      return makeNode(state, 'command_substitution', start, state.pos)
    }
    state.pos++
  }
  return makeNode(state, 'ERROR', start, state.pos)
}

function parseSimpleOrComplexDollar(state: ParserState): TsNode {
  const start = state.pos
  if (state.src.startsWith('$((', state.pos)) {
    return parseBalancedDelim(state, '$((', '))', 'arithmetic_expansion')
  }
  if (state.src.startsWith('$(', state.pos)) {
    return parseCommandSubstitution(state)
  }
  if (state.src.startsWith('${', state.pos)) {
    return parseBalancedDelim(state, '${', '}', 'expansion')
  }
  if (state.src.startsWith("$'", state.pos)) {
    return parseAnsiCString(state)
  }
  if (state.src.startsWith('$"', state.pos)) {
    state.pos++
    const inner = parseDoubleQuoted(state)
    return makeNode(
      state,
      inner.type === 'ERROR' ? 'ERROR' : 'translated_string',
      start,
      state.pos,
      [inner],
    )
  }
  if (state.src.startsWith('$[', state.pos)) {
    return parseBalancedDelim(state, '$[', ']', 'expansion')
  }

  // `$VAR` or `$?` / `$$` / `$1` / `$*` / `$@`
  state.pos++ // skip $
  if (state.pos < state.len) {
    const next = state.src[state.pos]!
    if (/[?@$#*!\-0-9]/.test(next)) {
      const nameStart = state.pos
      state.pos++
      const nameNode = makeNode(state, 'special_variable_name', nameStart, state.pos)
      return makeNode(state, 'simple_expansion', start, state.pos, [nameNode])
    }
    if (/[A-Za-z_]/.test(next)) {
      const nameStart = state.pos
      while (state.pos < state.len && /[A-Za-z0-9_]/.test(state.src[state.pos]!)) {
        state.pos++
      }
      const nameNode = makeNode(state, 'variable_name', nameStart, state.pos)
      return makeNode(state, 'simple_expansion', start, state.pos, [nameNode])
    }
  }
  return makeNode(state, 'word', start, state.pos)
}

function parseDoubleQuoted(state: ParserState): TsNode {
  const start = state.pos
  state.pos++ // skip opening "
  const children: TsNode[] = []
  let contentStart = state.pos

  const flushContent = () => {
    if (state.pos > contentStart) {
      children.push(makeNode(state, 'string_content', contentStart, state.pos))
    }
  }

  while (state.pos < state.len) {
    checkBudget(state)
    const ch = state.src[state.pos]!
    if (ch === '\\' && state.pos + 1 < state.len) {
      state.pos += 2
      continue
    }
    if (ch === '"') {
      flushContent()
      state.pos++
      return makeNode(state, 'string', start, state.pos, children)
    }
    if (ch === '$') {
      const peek = state.src[state.pos + 1]
      if (
        peek === '(' ||
        peek === '{' ||
        peek === '[' ||
        (peek && /[A-Za-z_?@$#*!\-0-9]/.test(peek))
      ) {
        flushContent()
        children.push(parseSimpleOrComplexDollar(state))
        contentStart = state.pos
        continue
      }
    }
    if (ch === '`') {
      flushContent()
      children.push(parseCommandSubstitution(state))
      contentStart = state.pos
      continue
    }
    state.pos++
  }

  return makeNode(state, 'ERROR', start, state.pos, children)
}

function isStopCharForWord(state: ParserState): boolean {
  if (state.pos >= state.len) return true
  const ch = state.src[state.pos]!
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === ';' ||
    ch === '&' ||
    ch === '|' ||
    ch === '<' ||
    ch === '>' ||
    ch === '(' ||
    ch === ')'
  )
}

function parseWordOrConcatenation(state: ParserState): TsNode | null {
  const start = state.pos
  const parts: TsNode[] = []

  while (!isStopCharForWord(state)) {
    checkBudget(state)
    const ch = state.src[state.pos]!

    if (ch === "'") {
      parts.push(parseSingleQuoted(state))
      continue
    }
    if (ch === '"') {
      parts.push(parseDoubleQuoted(state))
      continue
    }
    if (ch === '$') {
      parts.push(parseSimpleOrComplexDollar(state))
      continue
    }
    if (ch === '`') {
      parts.push(parseCommandSubstitution(state))
      continue
    }

    // Plain word segment (handling backslash escapes)
    const segStart = state.pos
    while (!isStopCharForWord(state)) {
      const c = state.src[state.pos]!
      if (c === "'" || c === '"' || c === '$' || c === '`') {
        break
      }
      if (c === '\\' && state.pos + 1 < state.len) {
        state.pos += 2
        continue
      }
      state.pos++
    }
    if (state.pos > segStart) {
      const raw = state.src.slice(segStart, state.pos)
      const isNumber = /^\d+$/.test(raw)
      parts.push(makeNode(state, isNumber ? 'number' : 'word', segStart, state.pos))
    }
  }

  if (parts.length === 0) {
    return null
  }
  if (parts.length === 1) {
    return parts[0]!
  }
  return makeNode(state, 'concatenation', start, state.pos, parts)
}

function tryParseRedirect(state: ParserState): TsNode | null {
  const saved = state.pos
  let fdNode: TsNode | null = null

  // Optional leading file descriptor digit(s) immediately before `<` or `>`
  const fdStart = state.pos
  while (state.pos < state.len && /[0-9]/.test(state.src[state.pos]!)) {
    state.pos++
  }
  const hasFd = state.pos > fdStart

  const rest = state.src.slice(state.pos)

  // Process substitution `<(...)` / `>(...)` is NOT a redirect
  if (!hasFd && (rest.startsWith('<(') || rest.startsWith('>('))) {
    state.pos = saved
    return null
  }

  // Herestring `<<<`
  if (rest.startsWith('<<<')) {
    const opStart = state.pos
    state.pos += 3
    const opNode = makeNode(state, '<<<', opStart, state.pos)
    skipHorizontalSpaces(state)
    const arg = parseWordOrConcatenation(state)
    const children: TsNode[] = []
    if (hasFd) {
      fdNode = makeNode(state, 'file_descriptor', fdStart, fdStart + (opStart - fdStart))
      children.push(fdNode)
    }
    children.push(opNode)
    if (arg) children.push(arg)
    return makeNode(state, 'herestring_redirect', saved, state.pos, children)
  }

  // Heredoc `<<-` or `<<`
  if (rest.startsWith('<<')) {
    const opStart = state.pos
    state.pos += rest.startsWith('<<-') ? 3 : 2
    const opNode = makeNode(state, state.src.slice(opStart, state.pos), opStart, state.pos)
    skipHorizontalSpaces(state)
    const delimNode = parseWordOrConcatenation(state)
    const rawDelim = delimNode?.text ?? ''
    const cleanDelim = rawDelim.replace(/^['"]|['"]$/g, '').replace(/\\/g, '')
    const children: TsNode[] = [opNode]
    if (delimNode) {
      children.push(
        makeNode(state, 'heredoc_start', delimNode.startIndex, delimNode.endIndex, [
          delimNode,
        ]),
      )
    }
    // Consume heredoc body if a newline follows on this command
    const nlIdx = state.src.indexOf('\n', state.pos)
    if (nlIdx !== -1 && cleanDelim) {
      let bodyCursor = nlIdx + 1
      const bodyStart = bodyCursor
      while (bodyCursor < state.len) {
        const lineEnd = state.src.indexOf('\n', bodyCursor)
        const nextLineStart = lineEnd === -1 ? state.len : lineEnd + 1
        const line = state.src.slice(bodyCursor, lineEnd === -1 ? state.len : lineEnd)
        const strippedLine = rest.startsWith('<<-') ? line.replace(/^\t+/, '') : line
        if (strippedLine === cleanDelim) {
          children.push(makeNode(state, 'heredoc_body', bodyStart, bodyCursor))
          children.push(
            makeNode(
              state,
              'heredoc_end',
              bodyCursor,
              lineEnd === -1 ? state.len : lineEnd,
            ),
          )
          state.pos = nextLineStart
          break
        }
        bodyCursor = nextLineStart
      }
    }
    return makeNode(state, 'heredoc_redirect', saved, state.pos, children)
  }

  // File redirections: `&>>`, `&>`, `>>`, `>|`, `>&`, `<&`, `>`, `<`
  let op: string | null = null
  for (const candidate of ['&>>', '&>', '>>', '>|', '>&', '<&', '>', '<']) {
    if (rest.startsWith(candidate)) {
      if ((candidate === '&>' || candidate === '&>>') && hasFd) {
        break
      }
      op = candidate
      break
    }
  }

  if (!op) {
    state.pos = saved
    return null
  }

  const opStart = state.pos
  state.pos += op.length
  const opNode = makeNode(state, op, opStart, state.pos)
  skipHorizontalSpaces(state)
  const target = parseWordOrConcatenation(state)
  const children: TsNode[] = []
  if (hasFd) {
    fdNode = makeNode(state, 'file_descriptor', fdStart, opStart)
    children.push(fdNode)
  }
  children.push(opNode)
  if (target) {
    children.push(target)
  }
  return makeNode(state, 'file_redirect', saved, state.pos, children)
}

function isVariableAssignmentWord(node: TsNode): boolean {
  return node.type === 'word' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(node.text)
}

function splitVariableAssignment(state: ParserState, node: TsNode): TsNode {
  const eqIdx = node.text.indexOf('=')
  const nameEnd = node.startIndex + eqIdx
  const nameNode = makeNode(state, 'variable_name', node.startIndex, nameEnd)
  const children: TsNode[] = [nameNode]
  if (nameEnd + 1 < node.endIndex) {
    children.push(makeNode(state, 'word', nameEnd + 1, node.endIndex))
  }
  return makeNode(state, 'variable_assignment', node.startIndex, node.endIndex, children)
}

function parseControlFlowOrCompound(
  state: ParserState,
  keyword: string,
  kwStart: number,
): TsNode {
  const nodeTypeMap: Record<string, string> = {
    if: 'if_statement',
    for: 'for_statement',
    while: 'while_statement',
    until: 'until_statement',
    case: 'case_statement',
    function: 'function_definition',
    select: 'for_statement',
  }
  const endTokenMap: Record<string, string> = {
    if: 'fi',
    for: 'done',
    while: 'done',
    until: 'done',
    case: 'esac',
    select: 'done',
  }

  const endKw = endTokenMap[keyword]
  let nesting = 1
  while (state.pos < state.len) {
    checkBudget(state)
    const ch = state.src[state.pos]!
    if (ch === "'" || ch === '"') {
      if (ch === "'") parseSingleQuoted(state)
      else parseDoubleQuoted(state)
      continue
    }
    if (keyword === 'function' && ch === '{') {
      parseBalancedDelim(state, '{', '}', 'compound_statement')
      break
    }
    if (endKw) {
      const wordMatch = state.src.slice(state.pos).match(/^[A-Za-z_][A-Za-z0-9_]*/)
      if (wordMatch) {
        const w = wordMatch[0]
        state.pos += w.length
        if (w === keyword) {
          nesting++
        } else if (w === endKw) {
          nesting--
          if (nesting === 0) break
        }
        continue
      }
    }
    state.pos++
  }

  return makeNode(
    state,
    nodeTypeMap[keyword] ?? 'compound_statement',
    kwStart,
    state.pos,
  )
}

function parseSimpleOrCompoundCommand(
  state: ParserState,
  stopOnCloseParen: boolean,
): TsNode | null {
  skipHorizontalSpaces(state)
  if (state.pos >= state.len) return null

  const ch = state.src[state.pos]!

  // Comment
  if (ch === '#') {
    return parseComment(state)
  }

  // Stop at list/pipe/statement terminators
  if (
    ch === '\n' ||
    ch === ';' ||
    ch === '|' ||
    ch === '&' ||
    (stopOnCloseParen && ch === ')')
  ) {
    return null
  }

  // Subshell `(...)` or arithmetic command `((...))`
  if (ch === '(') {
    if (state.src.startsWith('((', state.pos)) {
      return parseBalancedDelim(state, '((', '))', 'arithmetic_expansion')
    }
    return parseBalancedDelim(state, '(', ')', 'subshell')
  }

  // Brace group `{ ...; }`
  if (ch === '{' && (state.pos + 1 >= state.len || /[\s\n]/.test(state.src[state.pos + 1]!))) {
    return parseBalancedDelim(state, '{', '}', 'compound_statement')
  }

  // Extended test `[[ ... ]]`
  if (state.src.startsWith('[[', state.pos)) {
    return parseBalancedDelim(state, '[[', ']]', 'test_command')
  }

  // Process substitution at start
  if (state.src.startsWith('<(', state.pos) || state.src.startsWith('>(', state.pos)) {
    const open = state.src.slice(state.pos, state.pos + 2)
    return parseBalancedDelim(state, open, ')', 'process_substitution')
  }

  // Control flow keyword at command position
  const kwMatch = state.src.slice(state.pos).match(/^([a-z]+)(?=[\s;(\n]|$)/)
  if (kwMatch && SHELL_KEYWORDS.has(kwMatch[1]!)) {
    const kw = kwMatch[1]!
    const kwStart = state.pos
    state.pos += kw.length
    return parseControlFlowOrCompound(state, kw, kwStart)
  }

  // Parse simple command: leading assignments, redirects, command_name, arguments
  const cmdStart = state.pos
  const children: TsNode[] = []
  const trailingRedirects: TsNode[] = []
  let hasCommandName = false
  let isDeclaration = false

  while (state.pos < state.len) {
    checkBudget(state)
    skipHorizontalSpaces(state)
    if (state.pos >= state.len) break

    const c = state.src[state.pos]!
    if (
      c === '\n' ||
      c === ';' ||
      c === '|' ||
      c === '&' ||
      c === '#' ||
      (stopOnCloseParen && c === ')')
    ) {
      // Distinguish `&>` / `&>>` redirect from background `&`
      if (c === '&' && state.src[state.pos + 1] === '>') {
        // fall through to redirect parser
      } else {
        break
      }
    }

    // Process substitution as argument
    if (state.src.startsWith('<(', state.pos) || state.src.startsWith('>(', state.pos)) {
      const open = state.src.slice(state.pos, state.pos + 2)
      children.push(parseBalancedDelim(state, open, ')', 'process_substitution'))
      continue
    }

    // Function definition shorthand: `foo() { ... }`
    if (hasCommandName && state.src.startsWith('()', state.pos)) {
      state.pos += 2
      skipSpacesAndNewlines(state)
      if (state.src[state.pos] === '{') {
        parseBalancedDelim(state, '{', '}', 'compound_statement')
      }
      return makeNode(state, 'function_definition', cmdStart, state.pos)
    }

    // Redirection
    const redir = tryParseRedirect(state)
    if (redir) {
      trailingRedirects.push(redir)
      continue
    }

    // Unexpected unescaped `(` or `)` inside simple command -> ERROR / subshell
    if (c === '(' || c === ')') {
      const errStart = state.pos
      state.pos++
      children.push(makeNode(state, 'ERROR', errStart, state.pos))
      continue
    }

    const argNode = parseWordOrConcatenation(state)
    if (!argNode) break

    if (!hasCommandName && isVariableAssignmentWord(argNode)) {
      children.push(splitVariableAssignment(state, argNode))
      continue
    }

    if (
      !hasCommandName &&
      argNode.type === 'concatenation' &&
      argNode.children[0]?.type === 'word' &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(argNode.children[0].text)
    ) {
      children.push(
        makeNode(
          state,
          'variable_assignment',
          argNode.startIndex,
          argNode.endIndex,
          argNode.children,
        ),
      )
      continue
    }

    if (!hasCommandName) {
      hasCommandName = true
      if (argNode.type === 'word' && DECLARATION_KEYWORDS.has(argNode.text)) {
        isDeclaration = true
        children.push(argNode)
      } else {
        children.push(
          makeNode(state, 'command_name', argNode.startIndex, argNode.endIndex, [
            argNode,
          ]),
        )
      }
    } else {
      children.push(argNode)
    }
  }

  if (children.length === 0 && trailingRedirects.length === 0) {
    return null
  }

  const cmdNode = makeNode(
    state,
    isDeclaration ? 'declaration_command' : 'command',
    cmdStart,
    state.pos,
    children,
  )

  if (trailingRedirects.length > 0) {
    return makeNode(
      state,
      'redirected_statement',
      cmdStart,
      state.pos,
      [cmdNode, ...trailingRedirects],
    )
  }

  return cmdNode
}

function parsePipeline(
  state: ParserState,
  stopOnCloseParen: boolean,
): TsNode | null {
  skipHorizontalSpaces(state)
  const start = state.pos

  // Optional pipeline negation `!`
  if (
    state.src[state.pos] === '!' &&
    (state.pos + 1 >= state.len || /[\s\t]/.test(state.src[state.pos + 1]!))
  ) {
    state.pos++
  }

  const first = parseSimpleOrCompoundCommand(state, stopOnCloseParen)
  if (!first) return null

  const items: TsNode[] = [first]
  while (state.pos < state.len) {
    checkBudget(state)
    skipHorizontalSpaces(state)
    if (
      state.src[state.pos] === '|' &&
      state.src[state.pos + 1] !== '|'
    ) {
      const opStart = state.pos
      const opLen = state.src[state.pos + 1] === '&' ? 2 : 1
      state.pos += opLen
      items.push(makeNode(state, state.src.slice(opStart, state.pos), opStart, state.pos))
      skipSpacesAndNewlines(state)
      const next = parseSimpleOrCompoundCommand(state, stopOnCloseParen)
      if (!next) {
        items.push(makeNode(state, 'ERROR', state.pos, state.pos))
        break
      }
      items.push(next)
    } else {
      break
    }
  }

  if (items.length === 1) {
    return first
  }
  return makeNode(state, 'pipeline', start, state.pos, items)
}

function parseList(
  state: ParserState,
  stopOnCloseParen: boolean,
): TsNode | null {
  const start = state.pos
  const first = parsePipeline(state, stopOnCloseParen)
  if (!first) return null

  let current = first
  while (state.pos < state.len) {
    checkBudget(state)
    skipHorizontalSpaces(state)
    const two = state.src.slice(state.pos, state.pos + 2)
    if (two === '&&' || two === '||') {
      const opStart = state.pos
      state.pos += 2
      const opNode = makeNode(state, two, opStart, state.pos)
      skipSpacesAndNewlines(state)
      const right = parsePipeline(state, stopOnCloseParen)
      if (!right) {
        current = makeNode(state, 'ERROR', start, state.pos, [current, opNode])
        break
      }
      current = makeNode(state, 'list', start, state.pos, [current, opNode, right])
    } else {
      break
    }
  }
  return current
}

/**
 * Parses a Bash command string into a `tree-sitter-bash`-compatible AST.
 * Returns `null` when the timeout (`50ms`) or node budget (`50_000`) is exceeded.
 */
export function parseSource(
  source: string,
  timeoutMs: number = PARSE_TIMEOUT_MS,
  maxNodes: number = MAX_NODES,
): TsNode | null {
  const state: ParserState = {
    src: source,
    len: source.length,
    deadlineMs: timeoutMs === Infinity ? Infinity : Date.now() + timeoutMs,
    maxNodes,
    pos: 0,
    nodeCount: 0,
    depth: 0,
  }

  try {
    const children: TsNode[] = []
    while (state.pos < state.len) {
      checkBudget(state)
      skipHorizontalSpaces(state)
      if (state.pos >= state.len) break

      const ch = state.src[state.pos]!
      if (ch === '\n' || ch === '\r') {
        const start = state.pos
        state.pos++
        children.push(makeNode(state, '\n', start, state.pos))
        continue
      }
      if (ch === ';') {
        const start = state.pos
        state.pos++
        children.push(makeNode(state, ';', start, state.pos))
        continue
      }
      if (ch === '&' && state.src[state.pos + 1] !== '&' && state.src[state.pos + 1] !== '>') {
        const start = state.pos
        state.pos++
        children.push(makeNode(state, '&', start, state.pos))
        continue
      }
      if (ch === '#') {
        children.push(parseComment(state))
        continue
      }

      const before = state.pos
      const stmt = parseList(state, false)
      if (stmt) {
        children.push(stmt)
      }
      if (state.pos === before) {
        // Consume unexpected character as ERROR node to guarantee progress
        const errStart = state.pos
        state.pos++
        children.push(makeNode(state, 'ERROR', errStart, state.pos))
      }
    }

    return makeNode(state, 'program', 0, state.len, children)
  } catch (error) {
    if (error instanceof ParseBudgetExceededError) {
      return null
    }
    return null
  }
}

const MODULE: ParserModule = { parse: parseSource }
const READY = Promise.resolve()

export function ensureParserInitialized(): Promise<void> {
  return READY
}

export function getParserModule(): ParserModule | null {
  return MODULE
}
