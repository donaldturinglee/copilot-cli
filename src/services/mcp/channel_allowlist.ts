/**
 * MCP Channels capability gating, `--channels` flag parsing, and enterprise
 * `channelsEnabled` / `allowedChannelPlugins` enforcement.
 */

import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import {
  getAllowedChannels,
  getHasDevChannels,
  type ChannelEntry,
} from '../../bootstrap/state.js'
import { getInitialSettings } from '../../utilities/settings/settings.js'

const APPROVED_CHANNEL_MARKETPLACES = new Set([
  'claude-plugins-official',
  'anthropic-plugins',
])

/**
 * Parses a `--channels` CLI entry (`plugin:foo@marketplace` or `server:bar`)
 * into a structured `ChannelEntry`.
 */
export function parseChannelEntry(
  raw: string,
  dev = false,
): ChannelEntry | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith('plugin:')) {
    const spec = trimmed.slice('plugin:'.length)
    const atIdx = spec.indexOf('@')
    if (atIdx > 0) {
      return {
        kind: 'plugin',
        name: spec.slice(0, atIdx),
        marketplace: spec.slice(atIdx + 1),
        ...(dev ? { dev: true } : {}),
      }
    }
    return {
      kind: 'plugin',
      name: spec,
      marketplace: 'claude-plugins-official',
      ...(dev ? { dev: true } : {}),
    }
  }
  const serverName = trimmed.startsWith('server:')
    ? trimmed.slice('server:'.length)
    : trimmed
  return {
    kind: 'server',
    name: serverName,
    ...(dev ? { dev: true } : {}),
  }
}

export interface ChannelGateResult {
  allowed: boolean
  reason?: string
}

/**
 * Evaluates all 6 security gates before permitting an MCP server to push
 * inbound `claude/channel` notifications into the active session.
 */
export function gateChannelServer(params: {
  serverName: string
  capabilities?: ServerCapabilities
  pluginSource?: string
  allowedEntries?: readonly ChannelEntry[]
  hasDevOverride?: boolean
}): ChannelGateResult {
  const experimental = params.capabilities?.experimental as
    | Record<string, unknown>
    | undefined
  if (!experimental || !('claude/channel' in experimental)) {
    return { allowed: false, reason: 'Server does not advertise claude/channel' }
  }

  const settings = getInitialSettings()
  if (settings.channelsEnabled === false) {
    return {
      allowed: false,
      reason: 'MCP channels are disabled by organization policy (channelsEnabled=false)',
    }
  }

  const entries = params.allowedEntries ?? getAllowedChannels()
  if (entries.length === 0) {
    return {
      allowed: false,
      reason: 'Server was not requested via --channels for this session',
    }
  }

  const matchingEntry = entries.find(entry => {
    if (entry.kind === 'server') {
      return entry.name === params.serverName
    }
    if (params.pluginSource) {
      return params.pluginSource.startsWith(`${entry.name}@`)
    }
    return params.serverName.startsWith(`plugin:${entry.name}:`)
  })

  if (!matchingEntry) {
    return {
      allowed: false,
      reason: `Server "${params.serverName}" is not listed in --channels`,
    }
  }

  const devAllowed =
    params.hasDevOverride ?? Boolean(matchingEntry.dev || getHasDevChannels())
  if (devAllowed) {
    return { allowed: true }
  }

  if (matchingEntry.kind === 'plugin') {
    const orgAllowed = settings.allowedChannelPlugins
    if (Array.isArray(orgAllowed) && orgAllowed.length > 0) {
      const ok = orgAllowed.some(
        rule =>
          rule.plugin === matchingEntry.name &&
          rule.marketplace === matchingEntry.marketplace,
      )
      return ok
        ? { allowed: true }
        : {
            allowed: false,
            reason: `Plugin "${matchingEntry.name}@${matchingEntry.marketplace}" is not in allowedChannelPlugins`,
          }
    }
    if (APPROVED_CHANNEL_MARKETPLACES.has(matchingEntry.marketplace)) {
      return { allowed: true }
    }
  }

  return {
    allowed: false,
    reason:
      'Channel requires an approved official plugin or --dangerously-load-development-channels',
  }
}
