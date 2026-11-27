import { useEffect } from 'react'
import { useNotifications } from '../../context/notifications.js'

export type StatusNotificationOptions = {
  invalidSettingsCount?: number
  keybindingWarningCount?: number
  mcpErrorCount?: number
}

/**
 * Surfaces startup/session status notifications into the 4-priority
 * notification queue without disrupting the active composer.
 */
export function useStatusNotifications({
  invalidSettingsCount = 0,
  keybindingWarningCount = 0,
  mcpErrorCount = 0,
}: StatusNotificationOptions): void {
  const { addNotification } = useNotifications()

  useEffect(() => {
    if (invalidSettingsCount > 0) {
      addNotification({
        key: 'settings-validation-errors',
        text: `${invalidSettingsCount} settings validation issue(s) — run /doctor`,
        color: 'warning',
        priority: 'high',
        timeoutMs: 8000,
      })
    }
  }, [invalidSettingsCount, addNotification])

  useEffect(() => {
    if (keybindingWarningCount > 0) {
      addNotification({
        key: 'keybinding-warnings',
        text: `${keybindingWarningCount} keybinding warning(s) in keybindings.json`,
        color: 'warning',
        priority: 'medium',
        timeoutMs: 6000,
      })
    }
  }, [keybindingWarningCount, addNotification])

  useEffect(() => {
    if (mcpErrorCount > 0) {
      addNotification({
        key: 'mcp-connection-errors',
        text: `${mcpErrorCount} MCP server error(s) — run /status`,
        color: 'error',
        priority: 'high',
        timeoutMs: 8000,
      })
    }
  }, [mcpErrorCount, addNotification])
}
