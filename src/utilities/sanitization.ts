/**
 * Unicode sanitization to strip invisible formatting, bidi control, private-use,
 * and unassigned code points iteratively until reaching a fixed point.
 */

const MAX_ITERATIONS = 10

const UNICODE_CATEGORIES_REGEX = /[\p{Cf}\p{Co}\p{Cn}]/gu
const EXPLICIT_FALLBACK_REGEX =
  /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uE000-\uF8FF]/g

/**
 * Normalizes a string with NFKC and strips format/private-use/unassigned/bidi
 * characters until convergence (max 10 iterations).
 */
export function partiallySanitizeUnicode(input: string): string {
  let current = input
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const next = current
      .normalize('NFKC')
      .replace(UNICODE_CATEGORIES_REGEX, '')
      .replace(EXPLICIT_FALLBACK_REGEX, '')
    if (next === current) {
      return next
    }
    current = next
  }
  throw new Error(
    `Unicode sanitization did not converge after ${MAX_ITERATIONS} iterations.`,
  )
}

/**
 * Recursively applies `partiallySanitizeUnicode` to all strings, arrays, and
 * object keys and values while preserving primitive non-string values.
 */
export function recursivelySanitizeUnicode<Value>(value: Value): Value {
  if (typeof value === 'string') {
    return partiallySanitizeUnicode(value) as Value
  }
  if (Array.isArray(value)) {
    return value.map(item => recursivelySanitizeUnicode(item)) as Value
  }
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      sanitized[partiallySanitizeUnicode(key)] =
        recursivelySanitizeUnicode(entryValue)
    }
    return sanitized as Value
  }
  return value
}
