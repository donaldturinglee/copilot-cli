/**
 * Plugin ID (`<pluginName>@<marketplaceName>`) parsing, formatting, and
 * filesystem-safe key sanitization.
 */

export interface ParsedPluginIdentifier {
  name: string
  marketplace?: string
}

/**
 * Parses `plugin@marketplace` or bare `plugin` into `{ name, marketplace }`.
 */
export function parsePluginIdentifier(raw: string): ParsedPluginIdentifier {
  const trimmed = raw.trim()
  const atIdx = trimmed.indexOf('@')
  if (atIdx <= 0) {
    return { name: trimmed }
  }
  const name = trimmed.slice(0, atIdx).trim()
  const rest = trimmed.slice(atIdx + 1).trim()
  // Strip optional `@^semver` range suffix if present
  const marketplace = rest.replace(/@\^[^@]*$/, '')
  return {
    name,
    ...(marketplace ? { marketplace } : {}),
  }
}

/**
 * Formats `(name, marketplace)` into canonical `<name>@<marketplace>` ID.
 */
export function formatPluginIdentifier(
  name: string,
  marketplace: string,
): string {
  return `${name}@${marketplace}`
}

/**
 * Sanitizes a `pluginId` for safe directory naming under `~/.copilot/plugins/data/`.
 */
export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9._@-]/g, '_')
}
