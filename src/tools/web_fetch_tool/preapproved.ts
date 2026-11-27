/**
 * Pre-approved documentation hosts allowed by `WebFetch` without extra domain
 * warning prompts.
 */

export const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set([
  'docs.anthropic.com',
  'docs.claude.com',
  'code.claude.com',
  'developer.mozilla.org',
  'nodejs.org',
  'bun.sh',
  'www.typescriptlang.org',
  'typescriptlang.org',
  'react.dev',
  'docs.python.org',
  'doc.rust-lang.org',
  'pkg.go.dev',
  'github.com',
  'raw.githubusercontent.com',
])

export function isPreapprovedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return (
    PREAPPROVED_HOSTS.has(lower) ||
    (lower.startsWith('www.') && PREAPPROVED_HOSTS.has(lower.slice(4)))
  )
}
