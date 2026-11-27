/**
 * `ConfigTool` (`Config`):
 * Reads and writes validated Copilot CLI configuration settings across
 * `~/.copilot/settings.json` and `~/.copilot.json`, syncing `AppState`.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import type { ExternalPermissionMode } from '../../types/permissions.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utilities/config.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utilities/settings/settings.js'
import type { SettingsJson } from '../../utilities/settings/types.js'
import { CONFIG_TOOL_NAME } from './constants.js'
import { CONFIG_TOOL_DESCRIPTION, CONFIG_TOOL_PROMPT } from './prompt.js'
import {
  getSupportedSettingSpec,
  SUPPORTED_SETTINGS,
  validateSettingValue,
} from './supported_settings.js'

const ConfigInputSchema = z.object({
  setting: z
    .string()
    .describe('The setting key to get or update (e.g. "theme", "model", "effortLevel")'),
  value: z
    .union([z.string(), z.boolean(), z.number()])
    .optional()
    .describe('New value to assign; omit to read the current value'),
})

export type ConfigInput = z.infer<typeof ConfigInputSchema>

export interface ConfigOutput {
  success: boolean
  operation: 'get' | 'set'
  setting: string
  value?: unknown
  previousValue?: unknown
  newValue?: unknown
  error?: string
}

function readCurrentValue(setting: string): unknown {
  const spec = getSupportedSettingSpec(setting)
  if (!spec) return undefined
  if (spec.target === 'globalConfig') {
    const cfg = getGlobalConfig() as unknown as Record<string, unknown>
    return cfg[setting]
  }
  const settings = getInitialSettings() as Record<string, unknown>
  if (setting === 'permissions.defaultMode') {
    const perms = settings.permissions as Record<string, unknown> | undefined
    return perms?.defaultMode
  }
  return settings[setting]
}

export const ConfigTool = buildTool<ConfigInput, ConfigOutput>({
  name: CONFIG_TOOL_NAME,
  searchHint: 'read or update Copilot CLI configuration settings',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: ConfigInputSchema,

  isReadOnly: input => input.value === undefined,
  isConcurrencySafe: input => input.value === undefined,
  isDestructive: () => false,
  interruptBehavior: () => 'block',

  async description() {
    return CONFIG_TOOL_DESCRIPTION
  },

  async prompt() {
    return CONFIG_TOOL_PROMPT
  },

  async validateInput(input) {
    const spec = getSupportedSettingSpec(input.setting)
    if (!spec) {
      const supported = SUPPORTED_SETTINGS.map(s => s.key).join(', ')
      return {
        result: false,
        message: `Unsupported setting "${input.setting}". Supported settings: ${supported}`,
        errorCode: 1,
      }
    }
    if (input.value !== undefined) {
      const valCheck = validateSettingValue(spec, input.value)
      if (!valCheck.valid) {
        return { result: false, message: valCheck.error, errorCode: 2 }
      }
    }
    return { result: true }
  },

  async call(input, context: ToolUseContext) {
    const spec = getSupportedSettingSpec(input.setting)!
    const previousValue = readCurrentValue(input.setting)

    if (input.value === undefined) {
      return {
        data: {
          success: true,
          operation: 'get',
          setting: input.setting,
          value: previousValue,
        },
      }
    }

    if (spec.target === 'globalConfig') {
      saveGlobalConfig(current => ({
        ...current,
        [input.setting]: input.value,
      }))
      if (input.setting === 'verbose' && typeof input.value === 'boolean') {
        context.setAppState?.(prev => ({
          ...prev,
          verbose: input.value as boolean,
        }))
      }
      return {
        data: {
          success: true,
          operation: 'set',
          setting: input.setting,
          previousValue,
          newValue: input.value,
        },
      }
    }

    const patch: SettingsJson =
      input.setting === 'permissions.defaultMode'
        ? {
            permissions: {
              defaultMode: input.value as ExternalPermissionMode,
            },
          }
        : ({ [input.setting]: input.value } as SettingsJson)

    const { error } = updateSettingsForSource('userSettings', patch)
    if (error) {
      return {
        data: {
          success: false,
          operation: 'set',
          setting: input.setting,
          previousValue,
          error: error.message,
        },
      }
    }

    const refreshed = getInitialSettings()
    context.setAppState?.(prev => ({
      ...prev,
      settings: refreshed,
      ...(input.setting === 'effortLevel'
        ? { effortValue: input.value as 'low' | 'medium' | 'high' | 'max' }
        : {}),
      ...(input.setting === 'alwaysThinkingEnabled'
        ? { thinkingEnabled: input.value as boolean }
        : {}),
      ...(input.setting === 'permissions.defaultMode'
        ? {
            toolPermissionContext: {
              ...prev.toolPermissionContext,
              mode: input.value as ExternalPermissionMode,
            },
          }
        : {}),
    }))

    return {
      data: {
        success: true,
        operation: 'set',
        setting: input.setting,
        previousValue,
        newValue: input.value,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    if (!output.success) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output.error ?? `Failed to update setting "${output.setting}".`,
        is_error: true,
      }
    }
    if (output.operation === 'get') {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `${output.setting} = ${JSON.stringify(output.value ?? null)}`,
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Updated ${output.setting} from ${JSON.stringify(output.previousValue ?? null)} to ${JSON.stringify(output.newValue)}.`,
    }
  },
})
