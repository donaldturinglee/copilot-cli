/**
 * MCP tool output token budget validation and compact JSON schema inference
 * for oversized MCP JSON responses spilled to disk.
 */

const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25_000
export const MCP_CHARS_PER_TOKEN = 4
const MAX_SCHEMA_DEPTH = 4
const MAX_OBJECT_KEYS = 20

/**
 * Returns the configured `MAX_MCP_OUTPUT_TOKENS` limit (default 25,000 tokens).
 */
export function getMaxMcpOutputTokens(): number {
  const raw = Number(process.env.MAX_MCP_OUTPUT_TOKENS)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw)
  }
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS
}

/**
 * Returns the maximum inline character threshold for an MCP tool result.
 */
export function getMaxMcpOutputChars(): number {
  return getMaxMcpOutputTokens() * MCP_CHARS_PER_TOKEN
}

/**
 * Infers a compact structural TypeScript/jq-friendly type summary from a parsed
 * JSON value so the model knows how to query a persisted JSON file.
 */
export function inferCompactSchema(value: unknown, depth = 0): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value !== 'object') {
    return typeof value
  }
  if (depth >= MAX_SCHEMA_DEPTH) {
    return Array.isArray(value) ? '[...]' : '{...}'
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]'
    }
    return `[${inferCompactSchema(value[0], depth + 1)}] (length ${value.length})`
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return '{}'
  }
  const shown = entries
    .slice(0, MAX_OBJECT_KEYS)
    .map(([k, v]) => `${k}: ${inferCompactSchema(v, depth + 1)}`)
  if (entries.length > MAX_OBJECT_KEYS) {
    shown.push(`... +${entries.length - MAX_OBJECT_KEYS} keys`)
  }
  return `{${shown.join(', ')}}`
}
