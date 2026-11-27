import React from 'react'
import { Byline } from '../design_system/byline.js'
import { KeyboardShortcutHint } from '../design_system/keyboard_shortcut_hint.js'
import { useWizard } from './use_wizard.js'

export type WizardNavigationFooterProps = {
  canGoBack?: boolean
  nextLabel?: string
}

export function WizardNavigationFooter({
  canGoBack,
  nextLabel,
}: WizardNavigationFooterProps): React.ReactNode {
  const { currentStepIndex, totalSteps } = useWizard()
  const showBack = canGoBack ?? currentStepIndex > 0
  const isLast = currentStepIndex >= totalSteps - 1

  return (
    <Byline>
      <KeyboardShortcutHint
        shortcut="enter"
        action={nextLabel ?? (isLast ? 'finish' : 'next')}
      />
      {showBack ? <KeyboardShortcutHint shortcut="escape" action="back" /> : null}
      <KeyboardShortcutHint shortcut="ctrl+c" action="cancel" />
    </Byline>
  )
}
