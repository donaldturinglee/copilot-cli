/**
 * Argument parser for `/plugin [subcommand] [args]`.
 */

import type { ViewState } from './types.js'

/**
 * Parses `/plugin` slash command arguments into an initial `ViewState`.
 */
export function parsePluginArgs(rawArgs?: string): ViewState {
  const trimmed = (rawArgs ?? '').trim()
  if (!trimmed) {
    return { type: 'discover-plugins' }
  }

  const parts = trimmed.split(/\s+/)
  const first = parts[0]!.toLowerCase()
  const rest = parts.slice(1).join(' ').trim()

  switch (first) {
    case 'help':
      return { type: 'help' }
    case 'validate':
      return { type: 'validate', ...(rest ? { path: rest } : {}) }
    case 'discover':
    case 'browse':
    case 'install':
    case 'i':
      return {
        type: 'discover-plugins',
        ...(rest ? { targetPlugin: rest } : {}),
      }
    case 'manage':
    case 'installed':
    case 'list':
      return { type: 'manage-plugins' }
    case 'enable':
    case 'disable':
    case 'uninstall':
    case 'remove':
      return {
        type: 'manage-plugins',
        ...(rest ? { targetPlugin: rest } : {}),
        action: first === 'remove' ? 'uninstall' : first,
      }
    case 'marketplace':
    case 'marketplaces': {
      const sub = parts[1]?.toLowerCase()
      const subRest = parts.slice(2).join(' ').trim()
      if (sub === 'add') {
        return {
          type: 'add-marketplace',
          ...(subRest ? { initialValue: subRest } : {}),
        }
      }
      return { type: 'manage-marketplaces' }
    }
    default:
      return { type: 'discover-plugins', targetPlugin: trimmed }
  }
}
