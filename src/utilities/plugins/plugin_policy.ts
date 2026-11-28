/**
 * Enterprise marketplace source allowlist/blocklist (`strictKnownMarketplaces`
 * & `blockedMarketplaces`) and managed plugin policy (`policySettings.enabledPlugins`).
 */

import { getSettingsForSource } from '../settings/settings.js'
import type { MarketplaceSource } from './schemas.js'

function extractHost(source: MarketplaceSource): string | null {
  if (source.source === 'github') {
    return 'github.com'
  }
  if (source.source === 'url' || source.source === 'git') {
    try {
      return new URL(source.url).hostname.toLowerCase()
    } catch {
      const sshMatch = source.url.match(/^[^@]+@([^:/]+)[:/]/)
      return sshMatch?.[1]?.toLowerCase() ?? null
    }
  }
  return null
}

function sourceMatchesPolicyRule(
  candidate: MarketplaceSource,
  rule: Record<string, unknown>,
): boolean {
  if (rule.source === 'hostPattern' && typeof rule.hostPattern === 'string') {
    const host = extractHost(candidate)
    if (!host) return false
    try {
      return new RegExp(rule.hostPattern, 'i').test(host)
    } catch {
      return host === rule.hostPattern.toLowerCase()
    }
  }

  if (rule.source === 'pathPattern' && typeof rule.pathPattern === 'string') {
    if (candidate.source !== 'file' && candidate.source !== 'directory') {
      return false
    }
    try {
      return new RegExp(rule.pathPattern).test(candidate.path)
    } catch {
      return candidate.path === rule.pathPattern
    }
  }

  if (rule.source !== candidate.source) {
    return false
  }

  switch (candidate.source) {
    case 'github':
      return (
        typeof rule.repo === 'string' &&
        rule.repo.toLowerCase() === candidate.repo.toLowerCase()
      )
    case 'git':
    case 'url':
      return (
        typeof rule.url === 'string' &&
        rule.url.replace(/\/+$/, '') === candidate.url.replace(/\/+$/, '')
      )
    case 'file':
    case 'directory':
      return typeof rule.path === 'string' && rule.path === candidate.path
    case 'npm':
      return typeof rule.package === 'string' && rule.package === candidate.package
    case 'settings':
      return typeof rule.name === 'string' && rule.name === candidate.name
    default:
      return false
  }
}

/**
 * Evaluates enterprise `blockedMarketplaces` (checked first — deny always wins)
 * and `strictKnownMarketplaces` allowlist (`[]` blocks all).
 */
export function canUseMarketplaceSource(source: MarketplaceSource): {
  allowed: boolean
  blockedByBlocklist?: boolean
  allowedSources: string[]
} {
  const policy = getSettingsForSource('policySettings')
  const blockedList = policy?.blockedMarketplaces as
    | Array<Record<string, unknown>>
    | undefined
  if (Array.isArray(blockedList)) {
    for (const rule of blockedList) {
      if (sourceMatchesPolicyRule(source, rule)) {
        return {
          allowed: false,
          blockedByBlocklist: true,
          allowedSources: [],
        }
      }
    }
  }

  const strictAllow = policy?.strictKnownMarketplaces as
    | Array<Record<string, unknown>>
    | undefined
  if (strictAllow === undefined) {
    return { allowed: true, allowedSources: [] }
  }

  const allowedDescriptions = strictAllow.map(r =>
    String(r.repo ?? r.url ?? r.path ?? r.hostPattern ?? r.pathPattern ?? r.source),
  )

  if (strictAllow.length === 0) {
    return { allowed: false, allowedSources: [] }
  }

  const ok = strictAllow.some(rule => sourceMatchesPolicyRule(source, rule))
  return {
    allowed: ok,
    allowedSources: allowedDescriptions,
  }
}

/**
 * Returns true if `pluginId` is explicitly forbidden (`enabledPlugins[id] === false`)
 * by `policySettings`.
 */
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  const policy = getSettingsForSource('policySettings')
  return policy?.enabledPlugins?.[pluginId] === false
}

/**
 * Returns true if `pluginId` is locked (either forced on or off) by `policySettings`.
 */
export function isPluginManaged(pluginId: string): boolean {
  const policy = getSettingsForSource('policySettings')
  return policy?.enabledPlugins?.[pluginId] !== undefined
}

/**
 * Returns bare plugin names locked in `policySettings.enabledPlugins` so
 * `--plugin-dir` cannot shadow managed plugins.
 */
export function getManagedPluginNames(): Set<string> {
  const names = new Set<string>()
  const policy = getSettingsForSource('policySettings')
  for (const key of Object.keys(policy?.enabledPlugins ?? {})) {
    const atIdx = key.indexOf('@')
    names.add(atIdx > 0 ? key.slice(0, atIdx) : key)
  }
  return names
}
