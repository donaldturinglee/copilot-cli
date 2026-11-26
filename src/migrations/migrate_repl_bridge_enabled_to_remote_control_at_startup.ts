import { saveGlobalConfig } from '../utilities/config.js'

/**
 * Migrates the legacy `replBridgeEnabled` key in global config to `remoteControlAtStartup`.
 */
export function migrateReplBridgeEnabledToRemoteControlAtStartup(): void {
  saveGlobalConfig(prev => {
    const record = prev as Record<string, unknown>
    const oldValue = record.replBridgeEnabled
    if (oldValue === undefined) return prev
    if (prev.remoteControlAtStartup !== undefined) return prev
    const next = { ...prev, remoteControlAtStartup: Boolean(oldValue) }
    delete (next as Record<string, unknown>).replBridgeEnabled
    return next
  })
}
