export type WizardStepComponent = React.ComponentType

export type WizardContextValue<TData extends Record<string, unknown> = Record<string, unknown>> = {
  currentStepIndex: number
  totalSteps: number
  wizardData: Partial<TData>
  goNext: () => void
  goBack: () => void
  goToStep: (index: number) => void
  updateWizardData: (patch: Partial<TData>) => void
  cancel: () => void
  complete: () => void
}
