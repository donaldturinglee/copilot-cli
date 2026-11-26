import { getSettingsWithErrors } from './settings.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

let mcpErrorProvider: (() => ValidationError[]) | undefined

/**
 * Registers the Phase 8 MCP configuration error provider so `getSettingsWithAllErrors()`
 * surfaces MCP errors alongside settings.json validation errors without backward imports.
 */
export function registerMcpErrorProvider(
  provider: () => ValidationError[],
): void {
  mcpErrorProvider = provider
}

export function getSettingsWithAllErrors(): SettingsWithErrors {
  const result = getSettingsWithErrors()
  const mcpErrors = mcpErrorProvider?.() ?? []
  if (mcpErrors.length === 0) {
    return result
  }
  return {
    settings: result.settings,
    errors: [...result.errors, ...mcpErrors],
  }
}
