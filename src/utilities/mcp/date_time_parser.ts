/**
 * Natural-language and ISO date/date-time parser for MCP Elicitation fields,
 * falling back to `sideQuery` when strict ISO parsing does not match.
 */

import { getSmallFastModel } from '../model/model.js'
import { sideQuery } from '../side_query.js'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Parses `input` into an ISO `YYYY-MM-DD` date or RFC 3339 `date-time` string.
 */
export async function parseNaturalLanguageDateTime(
  input: string,
  format: 'date' | 'date-time',
  signal?: AbortSignal,
): Promise<{ success: true; value: string } | { success: false; error: string }> {
  const trimmed = input.trim()
  if (!trimmed) {
    return { success: false, error: 'Date/time input cannot be empty' }
  }

  if (format === 'date' && ISO_DATE_RE.test(trimmed)) {
    return { success: true, value: trimmed }
  }
  if (format === 'date-time' && ISO_DATETIME_RE.test(trimmed)) {
    return { success: true, value: trimmed }
  }

  // Deterministic JS Date parse fast path for standard strings
  const directMs = Date.parse(trimmed)
  if (!Number.isNaN(directMs)) {
    const dateObj = new Date(directMs)
    if (format === 'date') {
      return { success: true, value: dateObj.toISOString().slice(0, 10) }
    }
    return { success: true, value: dateObj.toISOString() }
  }

  try {
    const nowIso = new Date().toISOString()
    const targetDesc =
      format === 'date'
        ? 'ISO 8601 date in YYYY-MM-DD format'
        : 'RFC 3339 date-time in YYYY-MM-DDTHH:mm:ssZ format'
    const response = await sideQuery({
      model: getSmallFastModel(),
      system: `Convert the user's date/time expression relative to current time ${nowIso} into a single ${targetDesc}. Reply with ONLY the formatted timestamp or INVALID if unparseable.`,
      messages: [{ role: 'user', content: trimmed }],
      maxTokens: 64,
      signal,
      querySource: 'mcp_datetime_parse',
    })
    const textBlock = response.content.find(b => b.type === 'text')
    const candidate =
      textBlock && textBlock.type === 'text' ? textBlock.text.trim() : ''
    if (format === 'date' && ISO_DATE_RE.test(candidate)) {
      return { success: true, value: candidate }
    }
    if (format === 'date-time' && ISO_DATETIME_RE.test(candidate)) {
      return { success: true, value: candidate }
    }
  } catch {
    // Fall through to validation error
  }

  return {
    success: false,
    error:
      format === 'date'
        ? 'Could not parse date; expected YYYY-MM-DD'
        : 'Could not parse date-time; expected ISO 8601 (e.g. 2026-05-01T14:30:00Z)',
  }
}
