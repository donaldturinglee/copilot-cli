import React, { createContext, useCallback, useMemo, useState } from 'react'
import type { WizardContextValue, WizardStepComponent } from './types.js'

export const WizardContext = createContext<WizardContextValue | null>(null)

export type WizardProviderProps<
  TData extends Record<string, unknown> = Record<string, unknown>,
> = {
  steps: readonly WizardStepComponent[]
  initialData?: Partial<TData>
  onComplete: (data: Partial<TData>) => void
  onCancel?: () => void
  children?: React.ReactNode
}

export function WizardProvider<
  TData extends Record<string, unknown> = Record<string, unknown>,
>({
  steps,
  initialData = {},
  onComplete,
  onCancel,
  children,
}: WizardProviderProps<TData>): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [wizardData, setWizardData] = useState<Partial<TData>>(initialData)

  const goNext = useCallback(() => {
    setCurrentStepIndex(idx => Math.min(steps.length - 1, idx + 1))
  }, [steps.length])

  const goBack = useCallback(() => {
    setCurrentStepIndex(idx => Math.max(0, idx - 1))
  }, [])

  const goToStep = useCallback(
    (index: number) => {
      setCurrentStepIndex(Math.max(0, Math.min(steps.length - 1, index)))
    },
    [steps.length],
  )

  const updateWizardData = useCallback((patch: Partial<TData>) => {
    setWizardData(prev => ({ ...prev, ...patch }))
  }, [])

  const cancel = useCallback(() => {
    onCancel?.()
  }, [onCancel])

  const complete = useCallback(() => {
    onComplete(wizardData)
  }, [onComplete, wizardData])

  const value = useMemo<WizardContextValue>(
    () => ({
      currentStepIndex,
      totalSteps: steps.length,
      wizardData,
      goNext,
      goBack,
      goToStep,
      updateWizardData: updateWizardData as (
        patch: Partial<Record<string, unknown>>,
      ) => void,
      cancel,
      complete,
    }),
    [
      currentStepIndex,
      steps.length,
      wizardData,
      goNext,
      goBack,
      goToStep,
      updateWizardData,
      cancel,
      complete,
    ],
  )

  const ActiveStep = steps[currentStepIndex]

  return (
    <WizardContext.Provider value={value}>
      {children ?? (ActiveStep ? <ActiveStep /> : null)}
    </WizardContext.Provider>
  )
}
