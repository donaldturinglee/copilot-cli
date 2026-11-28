import React, { useState } from 'react'
import { setIsInteractive } from './bootstrap/state.js'
import { App } from './components/app.js'
import {
  computePendingSetupGates,
  StartupGates,
} from './dialog_launchers.js'
import { render } from './ink/root.js'
import { REPL } from './screens/repl.js'
import { drainPendingExtraction } from './services/extract_memories/extract_memories.js'
import type { Message } from './types/message.js'
import type { PermissionMode } from './types/permissions.js'
import { loadConversationForResume } from './utilities/conversation_recovery.js'
import { getCwd } from './utilities/cwd.js'
import {
  createEmptyFileHistoryState,
  fileHistoryRestoreStateFromLog,
  type FileHistoryState,
} from './utilities/file_history.js'
import { isFullscreenEnvEnabled } from './utilities/fullscreen.js'
import { gracefulShutdown } from './utilities/graceful_shutdown.js'
import { processResumedConversation } from './utilities/session_restore.js'
import { flushSessionStorage } from './utilities/session_storage.js'
import { parseSessionIdentifier } from './utilities/session_url.js'

export type InteractiveLaunchOptions = {
  permissionMode?: PermissionMode
  dangerouslySkipPermissions?: boolean
  model?: string
  verbose?: boolean
  fullscreen?: boolean
  skipSetupScreens?: boolean
  initialMessages?: Message[]
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
      initialMessages={options.initialMessages}
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

  let initialMessages: Message[] | undefined
  let restoredFileHistory: FileHistoryState = createEmptyFileHistoryState()
  if (rawOptions.continue || rawOptions.resume) {
    const resumeArg =
      typeof rawOptions.resume === 'string' ? rawOptions.resume : undefined
    const parsed = resumeArg ? parseSessionIdentifier(resumeArg) : null
    const loaded = await loadConversationForResume(
      parsed?.kind === 'session_id' ? parsed.sessionId : resumeArg,
      parsed?.kind === 'jsonl_file' ? parsed.path : undefined,
    )
    if (loaded) {
      const processed = await processResumedConversation(
        loaded.log,
        loaded.messages,
        {
          forkSession: Boolean(rawOptions.forkSession),
          resumeSessionAt:
            typeof rawOptions.resumeSessionAt === 'string'
              ? rawOptions.resumeSessionAt
              : undefined,
        },
      )
      initialMessages = processed.messages
      if (loaded.log.fileHistorySnapshots?.length) {
        fileHistoryRestoreStateFromLog(loaded.log.fileHistorySnapshots, next => {
          restoredFileHistory = next
        })
      }
    }
  }

  const options: InteractiveLaunchOptions = {
    permissionMode:
      typeof rawOptions.permissionMode === 'string'
        ? (rawOptions.permissionMode as PermissionMode)
        : undefined,
    dangerouslySkipPermissions: Boolean(rawOptions.dangerouslySkipPermissions),
    model:
      typeof rawOptions.model === 'string' ? rawOptions.model : undefined,
    verbose: Boolean(rawOptions.verbose),
    initialMessages,
  }

  const instance = render(
    <App
      initialState={{
        verbose: Boolean(options.verbose),
        ...(options.model ? { mainLoopModel: options.model } : {}),
        fileHistory: restoredFileHistory,
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
  await drainPendingExtraction()
  await flushSessionStorage()
  await gracefulShutdown(0)
}
