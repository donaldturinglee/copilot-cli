import { normalize } from 'path'
import { SETTING_SOURCES } from './constants.js'
import { getSettingsFilePathForSource } from './settings.js'
import { validateSettingsFileContent } from './validation.js'

export function isClaudeSettingsPath(filePath: string): boolean {
  const normalized = normalize(filePath).replace(/\\/g, '/').toLowerCase()
  if (
    normalized.endsWith('/.copilot/settings.json') ||
    normalized.endsWith('/.copilot/settings.local.json')
  ) {
    return true
  }

  for (const source of SETTING_SOURCES) {
    const sourcePath = getSettingsFilePathForSource(source)
    if (
      sourcePath &&
      normalize(sourcePath).replace(/\\/g, '/').toLowerCase() === normalized
    ) {
      return true
    }
  }
  return false
}

export function validateInputForSettingsFileEdit(
  filePath: string,
  originalContent: string,
  getUpdatedContent: () => string,
): { result: false; message: string; errorCode: number } | null {
  if (!isClaudeSettingsPath(filePath)) {
    return null
  }

  const originalValidation = validateSettingsFileContent(originalContent)
  if (!originalValidation.isValid) {
    return null
  }

  const updatedValidation = validateSettingsFileContent(getUpdatedContent())
  if (updatedValidation.isValid) {
    return null
  }

  return {
    result: false,
    errorCode: 10,
    message: `Invalid settings file edit for ${filePath}:\n${updatedValidation.error}`,
  }
}
