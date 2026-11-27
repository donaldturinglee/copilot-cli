import React from 'react'
import { DiffDialog } from '../components/diff/diff_dialog.js'
import { Feedback } from '../components/feedback.js'
import { HelpDialog } from '../components/help_v2/help_dialog.js'
import { ThemePicker } from '../components/theme_picker.js'
import { getMacroVersion } from '../constants/version.js'
import { Doctor } from '../screens/doctor.js'
import type { Command } from '../types/command.js'
import { saveGlobalConfig } from '../utilities/config.js'
import { getCwd } from '../utilities/cwd.js'
import {
  formatDoctorReportText,
  runDoctorDiagnostics,
} from '../utilities/doctor_diagnostic.js'
import { getReleaseNotes } from '../utilities/release_notes.js'
import { applySettingsChange } from '../utilities/settings/apply_settings_change.js'
import { updateSettingsForSource } from '../utilities/settings/settings.js'
import {
  makeLocalCommand,
  makeLocalJsxCommand,
  makePromptCommand,
} from './registry.js'
import { getCommandRuntime } from './session_commands.js'

export const GIT_DIAGNOSTIC_COMMANDS: Command[] = [
  makeLocalJsxCommand({
    name: 'diff',
    description: 'Inspect unstaged git diff in an interactive file viewer',
    call: async onDone => <DiffDialog onClose={() => onDone()} />,
  }),

  makePromptCommand({
    name: 'review',
    description: 'Review current git changes for bugs, security risks, and regressions',
    argumentHint: '[focus]',
    template:
      'Review the current working tree diff and recent commits for correctness, edge cases, type safety, and security vulnerabilities. Provide actionable findings ordered by severity.',
  }),

  makeLocalJsxCommand({
    name: 'help',
    aliases: ['?'],
    description: 'Show available slash commands, shortcuts, and tips',
    immediate: true,
    call: async (onDone, context) => {
      const commands = getCommandRuntime(context).getAllCommands?.() ?? []
      return <HelpDialog commands={commands} onClose={() => onDone()} />
    },
  }),

  makeLocalCommand({
    name: 'status',
    description: 'Display current session model, mode, workspace, and version',
    immediate: true,
    call: async (_args, context) => {
      const state = getCommandRuntime(context).getAppState?.()
      const model =
        state?.mainLoopModelForSession ??
        state?.mainLoopModel ??
        'claude-sonnet-4-6'
      const mode = state?.toolPermissionContext.mode ?? 'default'
      return {
        type: 'text',
        value: [
          `Copilot CLI v${getMacroVersion()}`,
          `Workspace: ${getCwd()}`,
          `Model:     ${model}`,
          `Mode:      ${mode}`,
          `Messages:  ${context.messages.length}`,
        ].join('\n'),
      }
    },
  }),

  makeLocalJsxCommand({
    name: 'doctor',
    description: 'Run environment, settings, keybindings, and workspace health checks',
    immediate: true,
    call: async (onDone, _context, args) => {
      const report = runDoctorDiagnostics()
      if (args.trim() === '--text') {
        onDone(formatDoctorReportText(report))
        return null
      }
      return <Doctor report={report} onDone={summary => onDone(summary)} />
    },
  }),

  makeLocalJsxCommand({
    name: 'theme',
    aliases: ['color'],
    description: 'Choose terminal color theme with live preview',
    immediate: true,
    call: async (onDone, _context, args) => {
      const explicit = args.trim()
      if (explicit) {
        saveGlobalConfig(prev => ({
          ...prev,
          theme: explicit as typeof prev.theme,
        }))
        onDone(`Theme set to "${explicit}".`)
        return null
      }
      return (
        <ThemePicker
          onSelect={theme => {
            saveGlobalConfig(prev => ({ ...prev, theme }))
            onDone(`Theme set to "${theme}".`)
          }}
          onCancel={() => onDone()}
        />
      )
    },
  }),

  makeLocalCommand({
    name: 'vim',
    description: 'Toggle 11-state Vim editing mode in the REPL input box',
    argumentHint: '[on|off]',
    immediate: true,
    call: async (args, context) => {
      const arg = args.trim().toLowerCase()
      const explicit = arg === 'on' ? true : arg === 'off' ? false : undefined
      const enabled =
        getCommandRuntime(context).onToggleVim?.(explicit) ??
        (explicit ?? true)
      saveGlobalConfig(prev => ({
        ...prev,
        editorMode: enabled ? 'vim' : 'normal',
      }))
      return {
        type: 'text',
        value: `Vim editing mode ${enabled ? 'enabled (NORMAL/INSERT)' : 'disabled (standard readline)'}.`,
      }
    },
  }),

  makeLocalCommand({
    name: 'keybindings',
    description: 'Show user keybindings.json path and customization instructions',
    call: async () => ({
      type: 'text',
      value:
        'Customize keybindings in ~/.copilot/keybindings.json (19 contexts supported; set action to null to unbind).',
    }),
  }),

  makeLocalCommand({
    name: 'terminal-setup',
    description: 'Configure Shift+Enter and Kitty/CSI-u keyboard protocol tips',
    call: async () => ({
      type: 'text',
      value:
        'Copilot CLI automatically enables Bracketed Paste, Focus events, and Kitty keyboard protocol on supported terminals.',
    }),
  }),

  makeLocalCommand({
    name: 'release-notes',
    description: 'Show highlights for the current Copilot CLI release',
    call: async () => {
      const notes = getReleaseNotes()
      const text = notes
        .map(
          n =>
            `v${n.version}\n${n.highlights.map(h => `  • ${h}`).join('\n')}`,
        )
        .join('\n\n')
      return { type: 'text', value: text }
    },
  }),

  makeLocalJsxCommand({
    name: 'feedback',
    description: 'Submit feedback or report an issue',
    call: async onDone => (
      <Feedback
        onSubmit={note =>
          onDone(`Feedback recorded (${note.length} chars). Thank you!`)
        }
        onCancel={() => onDone()}
      />
    ),
  }),

  makeLocalCommand({
    name: 'brief',
    description: 'Toggle brief compact output display mode',
    call: async (_args, context) => {
      const runtime = getCommandRuntime(context)
      const next = !Boolean(runtime.getAppState?.().isBriefOnly)
      runtime.setAppState?.(prev => ({ ...prev, isBriefOnly: next }))
      return {
        type: 'text',
        value: `Brief mode ${next ? 'enabled' : 'disabled'}.`,
      }
    },
  }),

  makePromptCommand({
    name: 'security-review',
    description: 'Perform a security audit on recent changes in this repository',
    template:
      'Perform a focused security review of recent changes in this repository: inspect authentication, authorization, injection vectors, path traversal, command execution, and secret handling.',
  }),

  makePromptCommand({
    name: 'commit',
    description: 'Stage changes and craft a clean commit message',
    argumentHint: '[message hint]',
    template:
      'Inspect `git status` and `git diff`, draft a concise conventional commit message summarizing the changes, and commit after confirming no unintended files are staged.',
  }),

  makePromptCommand({
    name: 'commit-push-pr',
    description: 'Commit staged changes, push branch, and open a pull request',
    argumentHint: '[pr title]',
    template:
      'Create a clean commit for the current changes, push the current branch to origin, and draft/open a pull request with a clear summary and test plan.',
  }),

  makeLocalCommand({
    name: 'version',
    description: 'Print Copilot CLI version',
    immediate: true,
    call: async () => ({
      type: 'text',
      value: `Copilot CLI v${getMacroVersion()}`,
    }),
  }),

  makeLocalCommand({
    name: 'sandbox-toggle',
    description: 'Quickly toggle OS sandbox enforcement on/off',
    call: async (_args, context) => {
      const runtime = getCommandRuntime(context)
      const current = Boolean(runtime.getAppState?.().settings.sandbox?.enabled)
      const next = !current
      updateSettingsForSource('userSettings', {
        sandbox: { enabled: next },
      })
      if (runtime.setAppState) {
        applySettingsChange('userSettings', runtime.setAppState)
      }
      return {
        type: 'text',
        value: `OS sandbox ${next ? 'enabled' : 'disabled'}.`,
      }
    },
  }),
]
