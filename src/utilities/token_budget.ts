/**
 * Prompt token-budget syntax parsing (`+500k`, `use 2m tokens`, etc.) and
 * continuation nudge message formatting.
 */

const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US')

function matchToTokens(match: RegExpMatchArray | null): number | null {
  if (!match?.[1] || !match[2]) {
    return null
  }
  const value = Number(match[1])
  const mult = MULTIPLIERS[match[2].toLowerCase()]
  if (Number.isNaN(value) || !mult || value <= 0) {
    return null
  }
  return Math.round(value * mult)
}

/**
 * Extracts an explicit token budget from prompt text (`+500k` at start/end or
 * `use/spend 500k tokens`), returning `null` if absent.
 */
export function parseTokenBudget(text: string): number | null {
  return (
    matchToTokens(text.match(SHORTHAND_START_RE)) ??
    matchToTokens(text.match(SHORTHAND_END_RE)) ??
    matchToTokens(text.match(VERBOSE_RE))
  )
}

/**
 * Finds character spans of token-budget directives for inline prompt highlighting.
 */
export function findTokenBudgetPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []

  const startMatch = SHORTHAND_START_RE.exec(text)
  if (startMatch) {
    const trimmedOffset = startMatch[0].length - startMatch[0].trimStart().length
    positions.push({
      start: startMatch.index + trimmedOffset,
      end: startMatch.index + startMatch[0].length,
    })
  }

  const endMatch = SHORTHAND_END_RE.exec(text)
  if (endMatch) {
    // Offset +1 for the leading whitespace captured by SHORTHAND_END_RE
    const start = endMatch.index + 1
    const end = endMatch.index + endMatch[0].trimEnd().length
    const overlapsStart = positions.some(p => start < p.end && end > p.start)
    if (!overlapsStart) {
      positions.push({ start, end })
    }
  }

  const verboseGlobal = new RegExp(VERBOSE_RE.source, 'gi')
  let match = verboseGlobal.exec(text)
  while (match !== null) {
    positions.push({
      start: match.index,
      end: match.index + match[0].length,
    })
    match = verboseGlobal.exec(text)
  }

  return positions
}

/**
 * Formats the meta continuation nudge injected when stopping below the 90%
 * token budget threshold.
 */
export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const fmt = (n: number) => NUMBER_FORMATTER.format(n)
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working \u2014 do not summarize.`
}
