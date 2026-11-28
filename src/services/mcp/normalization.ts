/**
 * MCP server and tool name normalization helpers ensuring all model-facing
 * tool names conform to `/^[a-zA-Z0-9_-]{1,64}$/`.
 */

/**
 * Sanitizes an arbitrary MCP server or tool name into valid Anthropic tool
 * identifier characters (`[a-zA-Z0-9_-]`).
 */
export function normalizeNameForMcp(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith('claude.ai ')) {
    return replaced.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  }
  return replaced
}

/**
 * Alias preserving v1 call-site naming where needed.
 */
export const normalizeNameForMCP = normalizeNameForMcp
