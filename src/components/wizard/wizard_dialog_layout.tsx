import React from 'react'
import { Dialog } from '../design_system/dialog.js'
import { useWizard } from './use_wizard.js'
import { WizardNavigationFooter } from './wizard_navigation_footer.js'

export type WizardDialogLayoutProps = {
  title: string
  subtitle?: string
  footer?: React.ReactNode
  children: React.ReactNode
}

export function WizardDialogLayout({
  title,
  subtitle,
  footer,
  children,
}: WizardDialogLayoutProps): React.ReactNode {
  const { currentStepIndex, totalSteps, cancel } = useWizard()
  const stepLabel = `Step ${currentStepIndex + 1} of ${totalSteps}`

  return (
    <Dialog
      title={title}
      subtitle={subtitle ? `${stepLabel} · ${subtitle}` : stepLabel}
      onCancel={cancel}
      footer={footer ?? <WizardNavigationFooter />}
    >
      {children}
    </Dialog>
  )
}
