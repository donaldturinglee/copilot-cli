/**
 * Default shell preference resolution (`bash` vs `powershell`).
 */

import { getInitialSettings } from '../settings/settings.js'
import { isPowerShellToolEnabled } from './shell_tool_utils.js'

export type DefaultShellKind = 'bash' | 'powershell'

export function resolveDefaultShell(): DefaultShellKind {
  const envShell = process.env.COPILOT_CLI_SHELL?.toLowerCase()
  if (envShell === 'powershell' || envShell === 'pwsh') {
    return 'powershell'
  }
  if (envShell === 'bash' || envShell === 'zsh' || envShell === 'sh') {
    return 'bash'
  }
  const settingShell = getInitialSettings().defaultShell
  if (settingShell === 'powershell' && isPowerShellToolEnabled()) {
    return 'powershell'
  }
  return 'bash'
}
