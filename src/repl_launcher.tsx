import React, { useState } from 'react'
import { setIsInteractive } from './bootstrap/state.js'
import { App } from './components/app.js'
import {
  computePendingSetupGates,
  StartupGates,
} from './dialog_launchers.js'
import { render } from './ink/root.js'
import { REPL } from './screens/repl.js'
import type { PermissionMode } from './types/permissions.js'
import { getCwd } from './utilities/cwd.js'
import { isFullscreenEnvEnabled } from './utilities/fullscreen.js'
import { gracefulShutdown } from './utilities/graceful_shutdown.js'

export type InteractiveLaunchOptions = {
  permissionMode?: PermissionMode
  dangerouslySkipPermissions?: boolean
  model?: string
  verbose?: boolean
  fullscreen?: boolean
  skipSetupScreens?: boolean
}

function InteractiveShell({
  initialPrompt,
  options,
  onExit,
}: {
  initialPrompt?: string
  options: InteractiveLaunchOptions
  onExit: () => void
}): React.ReactNode {
  const requestedMode: PermissionMode | undefined =
    options.dangerouslySkipPermissions
      ? 'bypassPermissions'
      : options.permissionMode
  const pendingGates = options.skipSetupScreens
    ? []
    : computePendingSetupGates({ requestedMode })
  const [gatesDone, setGatesDone] = useState(pendingGates.length === 0)

  if (!gatesDone) {
    return (
      <StartupGates
        cwd={getCwd()}
        requestedMode={requestedMode}
        onComplete={() => setGatesDone(true)}
        onAbort={onExit}
      />
    )
  }

  return (
    <REPL
      initialPrompt={initialPrompt}
      cwd={getCwd()}
      fullscreen={options.fullscreen ?? isFullscreenEnvEnabled()}
      onExit={onExit}
    />
  )
}

/**
 * Dynamically imported interactive REPL launcher called from `src/main.tsx`.
 * Keeping this in a separate module ensures `--version` and `-p` headless mode
 * pay zero React/Ink/REPL import overhead.
 */
export async function launchInteractiveRepl(
  initialPrompt?: string,
  rawOptions: Record<string, unknown> = {},
): Promise<void> {
  setIsInteractive(true)

  const options: InteractiveLaunchOptions = {
    permissionMode:
      typeof rawOptions.permissionMode === 'string'
        ? (rawOptions.permissionMode as PermissionMode)
        : undefined,
    dangerouslySkipPermissions: Boolean(rawOptions.dangerouslySkipPermissions),
    model:
      typeof rawOptions.model === 'string' ? rawOptions.model : undefined,
    verbose: Boolean(rawOptions.verbose),
  }

  const instance = render(
    <App
      initialState={{
        verbose: Boolean(options.verbose),
        ...(options.model ? { mainLoopModel: options.model } : {}),
      }}
      enableKeybindingWatcher={true}
    >
      <InteractiveShell
        initialPrompt={initialPrompt}
        options={options}
        onExit={() => instance.unmount()}
      />
    </App>,
  )

  await instance.waitUntilExit()
  await gracefulShutdown(0)
}
