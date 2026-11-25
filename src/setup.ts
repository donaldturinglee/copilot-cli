import chalk from 'chalk'
import { setCwdState, switchSession } from './bootstrap/state.js'
import { logEvent } from './services/analytics/index.js'
import { asSessionId } from './types/ids.js'
import type { PermissionMode } from './types/permissions.js'
import { getCurrentProjectConfig } from './utils/config.js'
import { logForDiagnosticsNoPii } from './utils/diag_logs.js'
import { isBareMode, isEnvTruthy } from './utils/env_utils.js'

export type SetupHooks = {
  initSinks?: () => void
  onSetupNonBare?: (context: {
    cwd: string
    worktreeEnabled: boolean
    worktreeName?: string
    tmuxEnabled: boolean
    worktreePrNumber?: number
    messagingSocketPath?: string
  }) => Promise<void>
}

let setupHooks: SetupHooks = {}

export function registerSetupHooks(hooks: Partial<SetupHooks>): void {
  setupHooks = { ...setupHooks, ...hooks }
}

function checkNodeVersion(): void {
  const majorMatch = process.version.match(/^v(\d+)\./)
  const majorVersion = majorMatch ? parseInt(majorMatch[1]!, 10) : 0
  if (!majorMatch || majorVersion < 18) {
    console.error(
      chalk.bold.red(
        'Error: Copilot CLI requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }
}

function checkRootBypassPermissionsSafety(
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
): void {
  if (
    permissionMode !== 'bypassPermissions' &&
    !allowDangerouslySkipPermissions
  ) {
    return
  }

  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0 &&
    process.env.IS_SANDBOX !== '1' &&
    !isEnvTruthy(process.env.COPILOT_CLI_BUBBLEWRAP)
  ) {
    process.stderr.write(
      '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n',
    )
    process.exit(1)
  }
}

/**
 * Shared environment and session setup executed before headless or interactive
 * dispatch. Validates Node runtime, session ID, CWD, and bypass-permission guards.
 */
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePrNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPii('info', 'setup_started')
  checkNodeVersion()

  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  setCwdState(cwd)

  if (!isBareMode() && setupHooks.onSetupNonBare) {
    await setupHooks.onSetupNonBare({
      cwd,
      worktreeEnabled,
      worktreeName,
      tmuxEnabled,
      worktreePrNumber,
      messagingSocketPath,
    })
  }

  setupHooks.initSinks?.()
  logEvent('tengu_started', {})

  checkRootBypassPermissionsSafety(
    permissionMode,
    allowDangerouslySkipPermissions,
  )

  if (process.env.NODE_ENV === 'test') {
    return
  }

  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    logEvent('tengu_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_duration: projectConfig.lastDuration,
      ...(projectConfig.lastAPIDuration !== undefined
        ? { last_session_api_duration: projectConfig.lastAPIDuration }
        : {}),
      ...(projectConfig.lastToolDuration !== undefined
        ? { last_session_tool_duration: projectConfig.lastToolDuration }
        : {}),
    })
  }
}
