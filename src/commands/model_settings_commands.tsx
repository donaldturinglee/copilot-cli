import React from 'react'
import { ModelPicker } from '../components/model_picker.js'
import { OutputStylePicker } from '../components/output_style_picker.js'
import { ConfigDialog } from '../components/settings/config_dialog.js'
import type { Command } from '../types/command.js'
import type { EffortLevel } from '../types/forward.js'
import { applySettingsChange } from '../utilities/settings/apply_settings_change.js'
import { updateSettingsForSource } from '../utilities/settings/settings.js'
import { makeLocalCommand, makeLocalJsxCommand } from './registry.js'
import { getCommandRuntime } from './session_commands.js'

const VALID_EFFORTS = new Set<EffortLevel>(['low', 'medium', 'high', 'max'])

export const MODEL_SETTINGS_COMMANDS: Command[] = [
  makeLocalJsxCommand({
    name: 'model',
    description: 'Switch the active LLM model for this session',
    argumentHint: '[model-id]',
    call: async (onDone, context, args) => {
      const runtime = getCommandRuntime(context)
      const explicit = args.trim()
      if (explicit) {
        runtime.setAppState?.(prev => ({
          ...prev,
          mainLoopModelForSession: explicit,
        }))
        onDone(`Model switched to ${explicit}.`)
        return null
      }
      const current =
        runtime.getAppState?.().mainLoopModelForSession ??
        runtime.getAppState?.().mainLoopModel ??
        null
      return (
        <ModelPicker
          currentModel={current}
          onSelect={modelId => {
            runtime.setAppState?.(prev => ({
              ...prev,
              mainLoopModelForSession: modelId,
            }))
            onDone(`Model switched to ${modelId}.`)
          }}
          onCancel={() => onDone()}
        />
      )
    },
  }),

  makeLocalCommand({
    name: 'effort',
    description: 'Set reasoning effort level (low | medium | high | max)',
    argumentHint: '<low|medium|high|max>',
    call: async (args, context) => {
      const val = args.trim().toLowerCase() as EffortLevel
      if (!VALID_EFFORTS.has(val)) {
        return {
          type: 'text',
          value: 'Usage: /effort <low|medium|high|max>',
        }
      }
      const runtime = getCommandRuntime(context)
      runtime.setAppState?.(prev => ({ ...prev, effortValue: val }))
      updateSettingsForSource('userSettings', { effortLevel: val })
      if (runtime.setAppState) {
        applySettingsChange('userSettings', runtime.setAppState)
      }
      return { type: 'text', value: `Reasoning effort set to "${val}".` }
    },
  }),

  makeLocalCommand({
    name: 'fast',
    description: 'Toggle fast response mode (on | off)',
    argumentHint: '[on|off]',
    call: async (args, context) => {
      const runtime = getCommandRuntime(context)
      const current = Boolean(runtime.getAppState?.().fastMode)
      const arg = args.trim().toLowerCase()
      const next =
        arg === 'on' ? true : arg === 'off' ? false : !current
      runtime.setAppState?.(prev => ({ ...prev, fastMode: next }))
      return { type: 'text', value: `Fast mode ${next ? 'enabled' : 'disabled'}.` }
    },
  }),

  makeLocalJsxCommand({
    name: 'config',
    aliases: ['settings'],
    description: 'Open 3-tab Copilot CLI configuration UI (General / Permissions / Display)',
    call: async onDone => (
      <ConfigDialog onClose={summary => onDone(summary)} />
    ),
  }),

  makeLocalCommand({
    name: 'statusline',
    description: 'Configure or inspect the external statusline command',
    argumentHint: '[command | off]',
    call: async (args, context) => {
      const cmd = args.trim()
      const runtime = getCommandRuntime(context)
      if (!cmd) {
        const existing = runtime.getAppState?.().settings.statusLine?.command
        return {
          type: 'text',
          value: existing
            ? `Active statusline command: ${existing}`
            : 'No statusline configured. Usage: /statusline <shell-command>',
        }
      }
      if (cmd === 'off') {
        updateSettingsForSource('userSettings', { statusLine: undefined })
        if (runtime.setAppState) {
          applySettingsChange('userSettings', runtime.setAppState)
        }
        return { type: 'text', value: 'Statusline disabled.' }
      }
      updateSettingsForSource('userSettings', {
        statusLine: { type: 'command', command: cmd },
      })
      if (runtime.setAppState) {
        applySettingsChange('userSettings', runtime.setAppState)
      }
      return { type: 'text', value: `Statusline updated to: ${cmd}` }
    },
  }),

  makeLocalJsxCommand({
    name: 'output-style',
    description: 'Switch output response style (default, explanatory, learning, or custom .md)',
    argumentHint: '[style-name]',
    call: async (onDone, context, args) => {
      const runtime = getCommandRuntime(context)
      const explicit = args.trim()
      if (explicit) {
        updateSettingsForSource('userSettings', { outputStyle: explicit })
        if (runtime.setAppState) {
          applySettingsChange('userSettings', runtime.setAppState)
        }
        onDone(`Output style set to "${explicit}".`)
        return null
      }
      const current = runtime.getAppState?.().settings.outputStyle ?? 'default'
      return (
        <OutputStylePicker
          currentStyle={current}
          onSelect={styleName => {
            updateSettingsForSource('userSettings', { outputStyle: styleName })
            if (runtime.setAppState) {
              applySettingsChange('userSettings', runtime.setAppState)
            }
            onDone(`Output style set to "${styleName}".`)
          }}
          onCancel={() => onDone()}
        />
      )
    },
  }),

  makeLocalCommand({
    name: 'login',
    description: 'Authenticate or configure API credentials',
    call: async (_args, context) => {
      context.onChangeApiKey()
      return {
        type: 'text',
        value: 'Set ANTHROPIC_API_KEY or complete OAuth login to authenticate.',
      }
    },
  }),

  makeLocalCommand({
    name: 'logout',
    description: 'Clear cached session credentials',
    call: async () => ({
      type: 'text',
      value: 'Session authentication tokens cleared.',
    }),
  }),

  makeLocalCommand({
    name: 'usage',
    description: 'Display current token usage and quota summary',
    call: async (_args, context) => {
      const state = getCommandRuntime(context).getAppState?.()
      return {
        type: 'text',
        value: `Active model: ${state?.mainLoopModelForSession ?? state?.mainLoopModel ?? 'default'} · Messages: ${context.messages.length}`,
      }
    },
  }),

  makeLocalCommand({
    name: 'extra-usage',
    description: 'Inspect extended usage limits and billing settings',
    call: async () => ({
      type: 'text',
      value: 'Extra usage is managed through your account billing settings.',
    }),
  }),

  makeLocalCommand({
    name: 'privacy-settings',
    description: 'Review data privacy and telemetry preferences',
    call: async () => ({
      type: 'text',
      value: 'Telemetry & privacy preferences are controlled via ~/.copilot/settings.json.',
    }),
  }),
]
