import { useContext } from 'react'
import type { WizardContextValue } from './types.js'
import { WizardContext } from './wizard_provider.js'

export function useWizard<
  TData extends Record<string, unknown> = Record<string, unknown>,
>(): WizardContextValue<TData> {
  const ctx = useContext(WizardContext)
  if (!ctx) {
    throw new Error('useWizard must be used within a WizardProvider')
  }
  return ctx as unknown as WizardContextValue<TData>
}
