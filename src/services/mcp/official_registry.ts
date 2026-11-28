/**
 * Official MCP registry URL allowlist cache.
 */

const OFFICIAL_MCP_HOST_SUFFIXES = [
  '.mcp.claude.com',
  '.anthropic.com',
  'mcp.githubcopilot.com',
  'api.githubcopilot.com',
]

const cachedOfficialUrls = new Set<string>()

/**
 * Prefetches official MCP registry URLs in the background (best-effort no-op
 * when offline).
 */
export async function prefetchOfficialMcpUrls(): Promise<void> {
  // Official host suffixes are statically known; dynamic registry entries can
  // be registered here without blocking startup.
}

/**
 * Registers an official MCP endpoint URL into the runtime allowlist.
 */
export function registerOfficialMcpUrl(url: string): void {
  cachedOfficialUrls.add(url.replace(/\/+$/, '').toLowerCase())
}

/**
 * Returns true if `url` belongs to a verified official MCP registry host.
 */
export function isOfficialMcpUrl(url: string): boolean {
  const clean = url.replace(/\/+$/, '').toLowerCase()
  if (cachedOfficialUrls.has(clean)) {
    return true
  }
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return OFFICIAL_MCP_HOST_SUFFIXES.some(suffix =>
      suffix.startsWith('.')
        ? host === suffix.slice(1) || host.endsWith(suffix)
        : host === suffix,
    )
  } catch {
    return false
  }
}
