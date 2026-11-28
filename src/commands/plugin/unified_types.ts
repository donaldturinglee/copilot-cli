/**
 * Reconstructed `UnifiedInstalledItem` discriminated union for the `/plugin`
 * Installed tab.
 */

import type { McpServerConnection } from '../../types/forward.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { PersistablePluginScope } from '../../utilities/plugins/schemas.js'

export type UnifiedInstalledItem =
  | {
      type: 'plugin'
      id: string
      name: string
      description?: string
      marketplace: string
      scope: 'user' | 'project' | 'local' | 'managed' | 'builtin'
      isEnabled: boolean
      errorCount: number
      errors: PluginError[]
      plugin: LoadedPlugin
      pendingEnable?: boolean
      pendingUpdate?: boolean
      pendingToggle?: 'will-enable' | 'will-disable'
    }
  | {
      type: 'failed-plugin'
      id: string
      name: string
      marketplace: string
      scope: PersistablePluginScope
      errorCount: number
      errors: PluginError[]
    }
  | {
      type: 'flagged-plugin'
      id: string
      name: string
      marketplace: string
      scope: 'flagged'
      reason: string
      text: string
      flaggedAt: string
    }
  | {
      type: 'mcp'
      id: string
      name: string
      description?: string
      scope: string
      status: 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed'
      client: McpServerConnection
      indented?: boolean
    }
