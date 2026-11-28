/**
 * Session identifier parser (`parseSessionIdentifier`): distinguishes local
 * `.jsonl` file paths (checked BEFORE `new URL()` so Windows `C:\...jsonl`
 * paths aren't misparsed as URL schemes), session UUIDs, and remote URLs.
 */

import { validateUuid } from './uuid.js'

export type ParsedSessionIdentifier =
  | { kind: 'jsonl_file'; path: string }
  | { kind: 'session_id'; sessionId: string }
  | { kind: 'url'; url: string }
  | { kind: 'title_or_search'; query: string }

/**
 * Parses a `--resume` argument into its concrete identifier kind.
 */
export function parseSessionIdentifier(raw: string): ParsedSessionIdentifier {
  const trimmed = raw.trim()
  if (trimmed.toLowerCase().endsWith('.jsonl')) {
    return { kind: 'jsonl_file', path: trimmed }
  }

  const validUuid = validateUuid(trimmed)
  if (validUuid) {
    return { kind: 'session_id', sessionId: validUuid }
  }

  if (/^https?:\/\//i.test(trimmed) || /^wss?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      return { kind: 'url', url: parsed.toString() }
    } catch {
      // Fall through to title/search
    }
  }

  return { kind: 'title_or_search', query: trimmed }
}
