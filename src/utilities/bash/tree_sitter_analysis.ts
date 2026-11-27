/**
 * AST-backed structural queries over Bash commands:
 * - `extractQuoteContext`: exact single/double/unquoted spans
 * - `extractCompoundStructure`: split compound statements & operators
 * - `hasActualOperatorNodes`: distinguishes true AST operators (`;`, `&&`, `|`)
 *   from literal escaped characters inside arguments (e.g. `find . -exec echo {} \;`)
 * - `extractDangerousPatterns`: collects AST-level substitutions, subshells, expansions
 */

import type { Node } from './parser.js'
import { PARSE_ABORTED, parseCommandRaw } from './parser.js'

export interface QuoteSpan {
  kind: 'single' | 'double' | 'ansi_c'
  startIndex: number
  endIndex: number
  text: string
}

export interface CompoundStructure {
  subcommands: string[]
  operators: string[]
  hasPipe: boolean
  hasAndOr: boolean
  hasSemicolon: boolean
  hasBackground: boolean
}

export interface DangerousAstPattern {
  type: string
  text: string
  startIndex: number
  endIndex: number
}

const OPERATOR_TYPES = new Set(['&&', '||', '|', '|&', ';', '&'])
const SUBSTITUTION_OR_DANGEROUS = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'arithmetic_expansion',
  'subshell',
  'compound_statement',
  'herestring_redirect',
  'heredoc_redirect',
  'ansi_c_string',
])

function visitTree(node: Node, visitor: (n: Node) => void): void {
  visitor(node)
  for (const child of node.children) {
    visitTree(child, visitor)
  }
}

export async function extractQuoteContext(
  command: string,
): Promise<QuoteSpan[] | null> {
  const root = await parseCommandRaw(command)
  if (!root || root === PARSE_ABORTED) return null
  const spans: QuoteSpan[] = []
  visitTree(root, node => {
    if (node.type === 'raw_string') {
      spans.push({
        kind: 'single',
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        text: node.text,
      })
    } else if (node.type === 'string') {
      spans.push({
        kind: 'double',
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        text: node.text,
      })
    } else if (node.type === 'ansi_c_string') {
      spans.push({
        kind: 'ansi_c',
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        text: node.text,
      })
    }
  })
  return spans
}

export async function extractCompoundStructure(
  command: string,
): Promise<CompoundStructure | null> {
  const root = await parseCommandRaw(command)
  if (!root || root === PARSE_ABORTED) return null

  const subcommands: string[] = []
  const operators: string[] = []

  function collect(node: Node): void {
    if (OPERATOR_TYPES.has(node.type)) {
      operators.push(node.type)
      return
    }
    if (
      node.type === 'command' ||
      node.type === 'declaration_command' ||
      node.type === 'redirected_statement'
    ) {
      subcommands.push(node.text.trim())
      return
    }
    for (const child of node.children) {
      collect(child)
    }
  }

  collect(root)
  return {
    subcommands: subcommands.filter(Boolean),
    operators,
    hasPipe: operators.includes('|') || operators.includes('|&'),
    hasAndOr: operators.includes('&&') || operators.includes('||'),
    hasSemicolon: operators.includes(';'),
    hasBackground: operators.includes('&'),
  }
}

/**
 * Returns `true` only when the Bash AST contains real shell operator nodes
 * (`&&`, `||`, `|`, `|&`, `;`, `&`) — never triggered by escaped `\;` inside
 * `find . -exec ... \;` or operators inside single/double quotes!
 * Returns `null` if the parser aborted or failed.
 */
export async function hasActualOperatorNodes(
  command: string,
): Promise<boolean | null> {
  const root = await parseCommandRaw(command)
  if (root === PARSE_ABORTED || root === null) {
    return null
  }
  let found = false
  visitTree(root, node => {
    if (OPERATOR_TYPES.has(node.type)) {
      found = true
    }
  })
  return found
}

export async function extractDangerousPatterns(
  command: string,
): Promise<DangerousAstPattern[] | null> {
  const root = await parseCommandRaw(command)
  if (!root || root === PARSE_ABORTED) return null
  const patterns: DangerousAstPattern[] = []
  visitTree(root, node => {
    if (SUBSTITUTION_OR_DANGEROUS.has(node.type)) {
      patterns.push({
        type: node.type,
        text: node.text,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
      })
    }
  })
  return patterns
}
