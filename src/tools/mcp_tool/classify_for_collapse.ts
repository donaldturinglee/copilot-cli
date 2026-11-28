/**
 * Heuristic read/search classification for common MCP tools (GitHub, Slack,
 * Linear, Notion, Jira, Sentry, Datadog, Grafana, Stripe, etc.) so contiguous
 * read-only MCP calls collapse cleanly in the transcript view.
 */

export type McpCollapseCategory = { kind: 'read' | 'search' }

const SEARCH_VERB_PREFIXES = [
  'search',
  'find',
  'query',
  'list',
  'filter',
  'lookup',
  'grep',
]

const READ_VERB_PREFIXES = [
  'get',
  'read',
  'fetch',
  'view',
  'describe',
  'inspect',
  'show',
  'retrieve',
]

/**
 * Classifies `(serverName, toolName)` as `'search'`, `'read'`, or `null` (do not
 * collapse).
 */
export function classifyMcpToolForCollapse(
  _serverName: string,
  toolName: string,
): McpCollapseCategory | null {
  const lower = toolName.toLowerCase()
  for (const prefix of SEARCH_VERB_PREFIXES) {
    if (
      lower === prefix ||
      lower.startsWith(`${prefix}_`) ||
      lower.startsWith(`${prefix}-`)
    ) {
      return { kind: 'search' }
    }
  }
  for (const prefix of READ_VERB_PREFIXES) {
    if (
      lower === prefix ||
      lower.startsWith(`${prefix}_`) ||
      lower.startsWith(`${prefix}-`)
    ) {
      return { kind: 'read' }
    }
  }
  return null
}
