/**
 * Allowlist and validators for settings readable/writable through `ConfigTool`.
 */

import { EXTERNAL_PERMISSION_MODES } from '../../types/permissions.js'

export type ConfigTarget = 'userSettings' | 'globalConfig'

export interface SupportedSettingSpec {
  key: string
  target: ConfigTarget
  type: 'boolean' | 'string' | 'enum'
  allowedValues?: readonly string[]
  description: string
}

export const SUPPORTED_SETTINGS: ReadonlyArray<SupportedSettingSpec> = [
  {
    key: 'theme',
    target: 'globalConfig',
    type: 'enum',
    allowedValues: [
      'dark',
      'light',
      'light-daltonized',
      'dark-daltonized',
      'light-ansi',
      'dark-ansi',
      'auto',
    ],
    description: 'Terminal UI color theme',
  },
  {
    key: 'verbose',
    target: 'globalConfig',
    type: 'boolean',
    description: 'Enable verbose CLI logging and output',
  },
  {
    key: 'model',
    target: 'userSettings',
    type: 'string',
    description: 'Default main-loop model name or alias',
  },
  {
    key: 'effortLevel',
    target: 'userSettings',
    type: 'enum',
    allowedValues: ['low', 'medium', 'high', 'max'],
    description: 'Reasoning effort level',
  },
  {
    key: 'alwaysThinkingEnabled',
    target: 'userSettings',
    type: 'boolean',
    description: 'Enable extended thinking by default',
  },
  {
    key: 'defaultShell',
    target: 'userSettings',
    type: 'enum',
    allowedValues: ['bash', 'powershell'],
    description: 'Default shell tool preference',
  },
  {
    key: 'language',
    target: 'userSettings',
    type: 'string',
    description: 'Preferred assistant response language',
  },
  {
    key: 'outputStyle',
    target: 'userSettings',
    type: 'string',
    description: 'Active output style name',
  },
  {
    key: 'autoMemoryEnabled',
    target: 'userSettings',
    type: 'boolean',
    description: 'Enable automatic memory extraction',
  },
  {
    key: 'plansDirectory',
    target: 'userSettings',
    type: 'string',
    description: 'Project-relative directory for storing plan files',
  },
  {
    key: 'permissions.defaultMode',
    target: 'userSettings',
    type: 'enum',
    allowedValues: [...EXTERNAL_PERMISSION_MODES],
    description: 'Default permission mode',
  },
]

const SPEC_BY_KEY = new Map<string, SupportedSettingSpec>(
  SUPPORTED_SETTINGS.map(spec => [spec.key, spec]),
)

export function getSupportedSettingSpec(
  key: string,
): SupportedSettingSpec | undefined {
  return SPEC_BY_KEY.get(key)
}

export function validateSettingValue(
  spec: SupportedSettingSpec,
  value: unknown,
): { valid: true } | { valid: false; error: string } {
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') {
      return {
        valid: false,
        error: `Setting "${spec.key}" requires a boolean value.`,
      }
    }
    return { valid: true }
  }

  if (spec.type === 'enum') {
    if (typeof value !== 'string' || !spec.allowedValues?.includes(value)) {
      return {
        valid: false,
        error: `Setting "${spec.key}" must be one of: ${spec.allowedValues?.join(', ')}.`,
      }
    }
    return { valid: true }
  }

  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `Setting "${spec.key}" requires a string value.`,
    }
  }
  return { valid: true }
}
