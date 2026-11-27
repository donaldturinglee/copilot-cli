import React, { useState } from 'react'
import { setSessionTrustAccepted } from './bootstrap/state.js'
import { AutoModeOptInDialog } from './components/auto_mode_opt_in_dialog.js'
import { BypassPermissionsModeDialog } from './components/bypass_permissions_mode_dialog.js'
import { Onboarding } from './components/onboarding.js'
import { TrustDialog } from './components/trust_dialog.js'
import type { PermissionMode } from './types/permissions.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
} from './utilities/config.js'
import { getCwd } from './utilities/cwd.js'

export type SetupGateStep =
  | 'onboarding'
  | 'trust'
  | 'bypass_confirm'
  | 'auto_opt_in'
  | 'done'

export type SetupGatesConfig = {
  cwd?: string
  requestedMode?: PermissionMode
  skipOnboarding?: boolean
  skipTrust?: boolean
  persist?: boolean
}

export function computePendingSetupGates(
  config: SetupGatesConfig = {},
): SetupGateStep[] {
  const steps: SetupGateStep[] = []
  const globalCfg = getGlobalConfig()

  if (!config.skipOnboarding && !globalCfg.hasCompletedOnboarding) {
    steps.push('onboarding')
  }
  if (!config.skipTrust && !checkHasTrustDialogAccepted()) {
    steps.push('trust')
  }
  if (config.requestedMode === 'bypassPermissions') {
    steps.push('bypass_confirm')
  } else if (config.requestedMode === 'auto') {
    steps.push('auto_opt_in')
  }
  return steps
}

export type StartupGatesProps = SetupGatesConfig & {
  onComplete: (result: { trusted: boolean; approvedMode?: PermissionMode }) => void
  onAbort: () => void
  children?: React.ReactNode
}

/**
 * Interactive startup gate sequence (`showSetupScreens` state machine):
 * Onboarding -> TrustDialog -> Permission Mode confirmation -> REPL.
 */
export function StartupGates({
  cwd = getCwd(),
  requestedMode,
  skipOnboarding = false,
  skipTrust = false,
  persist = true,
  onComplete,
  onAbort,
  children,
}: StartupGatesProps): React.ReactNode {
  const [queue] = useState<SetupGateStep[]>(() =>
    computePendingSetupGates({
      cwd,
      requestedMode,
      skipOnboarding,
      skipTrust,
      persist,
    }),
  )
  const [stepIndex, setStepIndex] = useState(0)
  const [approvedMode, setApprovedMode] = useState<PermissionMode | undefined>(
    requestedMode,
  )

  const currentStep: SetupGateStep = queue[stepIndex] ?? 'done'

  const advance = (modeOverride?: PermissionMode) => {
    const nextMode = modeOverride ?? approvedMode
    if (modeOverride) setApprovedMode(modeOverride)
    const nextIdx = stepIndex + 1
    setStepIndex(nextIdx)
    if (nextIdx >= queue.length) {
      onComplete({ trusted: true, approvedMode: nextMode })
    }
  }

  if (currentStep === 'onboarding') {
    return (
      <Onboarding
        persist={persist}
        onComplete={() => advance()}
        onCancel={onAbort}
      />
    )
  }

  if (currentStep === 'trust') {
    return (
      <TrustDialog
        cwd={cwd}
        persist={persist}
        onTrust={() => {
          setSessionTrustAccepted(true)
          advance()
        }}
        onReject={onAbort}
      />
    )
  }

  if (currentStep === 'bypass_confirm') {
    return (
      <BypassPermissionsModeDialog
        onAccept={() => advance('bypassPermissions')}
        onDecline={() => advance('default')}
      />
    )
  }

  if (currentStep === 'auto_opt_in') {
    return (
      <AutoModeOptInDialog
        onAccept={() => advance('auto')}
        onDecline={() => advance('default')}
      />
    )
  }

  return <>{children}</>
}
