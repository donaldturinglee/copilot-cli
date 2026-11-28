/**
 * Formats inbound MCP Channel notifications into sanitized `<channel ...>` XML
 * blocks.
 */

const SAFE_ATTR_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Wraps a channel notification message in `<channel source="..." ...>` tags,
 * dropping any metadata keys that are not strict identifier tokens.
 */
export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, unknown>,
): string {
  const attrs: string[] = [`source="${escapeXmlAttr(serverName)}"`]
  if (meta) {
    for (const [key, val] of Object.entries(meta)) {
      if (!SAFE_ATTR_KEY_RE.test(key) || key === 'source') {
        continue
      }
      if (
        typeof val === 'string' ||
        typeof val === 'number' ||
        typeof val === 'boolean'
      ) {
        attrs.push(`${key}="${escapeXmlAttr(String(val))}"`)
      }
    }
  }
  return `<channel ${attrs.join(' ')}>\n${content}\n</channel>`
}
