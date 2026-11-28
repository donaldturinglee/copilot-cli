import type { UUID } from 'crypto'
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import React from 'react'
import { getSessionId } from '../bootstrap/state.js'
import { ExportDialog } from '../components/export_dialog.js'
import { MemoryFileSelector } from '../components/memory/memory_file_selector.js'
import { ResumeConversation } from '../screens/resume_conversation.js'
import { resetMicrocompactState } from '../services/compact/micro_compact.js'
import { resetLastMemoryMessageUuid } from '../services/session_memory/session_memory.js'
import { resetSessionMemoryState } from '../services/session_memory/session_memory_utils.js'
import type { AppState } from '../state/app_state_store.js'
import type { Command, LocalJsxCommandContext } from '../types/command.js'
import type { LogOption } from '../types/logs.js'
import { getCwd } from '../utilities/cwd.js'
import { renderTranscriptMarkdown } from '../utilities/export_renderer.js'
import { createEmptyFileHistoryState } from '../utilities/file_history.js'
import { applyPermissionUpdates } from '../utilities/permissions/permission_update.js'
import {
  loadMessageLogs,
  saveCustomTitle,
  saveTag,
} from '../utilities/session_storage.js'
import {
  formatSideQuestionResponse,
  parseSideQuestion,
} from '../utilities/side_question.js'
import {
  makeLocalCommand,
  makeLocalJsxCommand,
  makePromptCommand,
} from './registry.js'
import { rewindCommand } from './rewind/index.js'

export type CommandRuntimeHooks = {
  getAppState?: () => AppState
  setAppState?: (updater: (prev: AppState) => AppState) => void
  onRequestExit?: () => void
  onToggleVim?: (explicit?: boolean) => boolean
  getSavedLogs?: () => LogOption[]
  setSessionTitle?: (title: string) => void
  addSessionTag?: (tag: string) => void
  copyToClipboard?: (text: string) => boolean
  getAllCommands?: () => Command[]
  openMessageSelector?: () => void
}

export function getCommandRuntime(
  context: LocalJsxCommandContext,
): CommandRuntimeHooks {
  return context as unknown as CommandRuntimeHooks
}

export const SESSION_COMMANDS: Command[] = [
  makeLocalCommand({
    name: 'clear',
    aliases: ['reset', 'new'],
    description: 'Clear conversation history and start a fresh session',
    call: async (_args, context) => {
      context.setMessages(() => [])
      resetSessionMemoryState()
      resetLastMemoryMessageUuid()
      resetMicrocompactState()
      getCommandRuntime(context).setAppState?.(prev => ({
        ...prev,
        fileHistory: createEmptyFileHistoryState(),
      }))
      return { type: 'text', value: 'Conversation cleared.' }
    },
  }),

  makeLocalJsxCommand({
    name: 'resume',
    description: 'Resume a previous saved conversation session',
    call: async (onDone, context) => {
      const runtime = getCommandRuntime(context)
      const logs =
        runtime.getSavedLogs?.() ?? (await loadMessageLogs().catch(() => []))
      return (
        <ResumeConversation
          logs={logs}
          onSelect={log => {
            if (log.sessionId && context.resume) {
              void context.resume(
                log.sessionId as `${string}-${string}-${string}-${string}-${string}`,
                log,
                'slash_command_picker',
              )
            }
            onDone(
              `Resumed session: ${log.customTitle ?? log.summary ?? log.firstPrompt}`,
            )
          }}
          onCancel={() => onDone()}
        />
      )
    },
  }),

  makeLocalCommand({
    name: 'branch',
    aliases: ['fork'],
    description: 'Branch the current conversation into a new fork',
    argumentHint: '[name]',
    call: async (args, context) => {
      const label = args.trim() || `branch-${Date.now().toString(36)}`
      const runtime = getCommandRuntime(context)
      runtime.setSessionTitle?.(label)
      void saveCustomTitle(getSessionId() as UUID, label).catch(() => {})
      return {
        type: 'text',
        value: `Created conversation branch "${label}" (${context.messages.length} messages preserved).`,
      }
    },
  }),

  rewindCommand,

  makeLocalCommand({
    name: 'rename',
    description: 'Rename the current conversation session',
    argumentHint: '<title>',
    call: async (args, context) => {
      const title = args.trim()
      if (!title) {
        return { type: 'text', value: 'Usage: /rename <new session title>' }
      }
      getCommandRuntime(context).setSessionTitle?.(title)
      void saveCustomTitle(getSessionId() as UUID, title).catch(() => {})
      return { type: 'text', value: `Session renamed to "${title}".` }
    },
  }),

  makeLocalCommand({
    name: 'tag',
    description: 'Attach a searchable tag to the current session',
    argumentHint: '<tag>',
    call: async (args, context) => {
      const tag = args.trim()
      if (!tag) {
        return { type: 'text', value: 'Usage: /tag <tag-name>' }
      }
      getCommandRuntime(context).addSessionTag?.(tag)
      void saveTag(getSessionId() as UUID, tag).catch(() => {})
      return { type: 'text', value: `Added session tag #${tag}.` }
    },
  }),

  makeLocalJsxCommand({
    name: 'export',
    description: 'Export the current conversation transcript to Markdown',
    argumentHint: '[filename.md]',
    call: async (onDone, context, args) => {
      const target = args.trim()
      if (target) {
        const outPath = resolve(getCwd(), target)
        const md = renderTranscriptMarkdown(context.messages)
        writeFileSync(outPath, md, 'utf8')
        onDone(`Exported transcript to ${outPath}`)
        return null
      }
      return (
        <ExportDialog
          messages={context.messages}
          onDone={summary => onDone(summary)}
          onCancel={() => onDone()}
        />
      )
    },
  }),

  makeLocalCommand({
    name: 'copy',
    description: 'Copy the latest assistant response to the clipboard',
    call: async (_args, context) => {
      const lastAssistant = [...context.messages]
        .reverse()
        .find(m => m.type === 'assistant')
      if (!lastAssistant || lastAssistant.type !== 'assistant') {
        return { type: 'text', value: 'No assistant response to copy yet.' }
      }
      const text = Array.isArray(lastAssistant.message.content)
        ? lastAssistant.message.content
            .filter(b => b.type === 'text')
            .map(b => (b.type === 'text' ? b.text : ''))
            .join('\n')
        : ''
      getCommandRuntime(context).copyToClipboard?.(text)
      return {
        type: 'text',
        value: `Copied ${text.length} character(s) from the last response.`,
      }
    },
  }),

  makeLocalCommand({
    name: 'btw',
    description: 'Ask a quick ephemeral side question without polluting context',
    argumentHint: '<question>',
    immediate: true,
    call: async args => {
      const req = parseSideQuestion(args)
      if (!req) {
        return { type: 'text', value: 'Usage: /btw <quick side question>' }
      }
      return {
        type: 'text',
        value: formatSideQuestionResponse(
          req.question,
          'Side question noted (ephemeral — not added to main conversation context).',
        ),
      }
    },
  }),

  makeLocalCommand({
    name: 'exit',
    aliases: ['quit'],
    description: 'Exit the interactive Copilot CLI session',
    immediate: true,
    call: async (_args, context) => {
      getCommandRuntime(context).onRequestExit?.()
      return { type: 'text', value: 'Goodbye!' }
    },
  }),

  makeLocalCommand({
    name: 'add-dir',
    description: 'Grant read/write workspace access to an additional directory',
    argumentHint: '<path>',
    call: async (args, context) => {
      const rawDir = args.trim()
      if (!rawDir) {
        return { type: 'text', value: 'Usage: /add-dir <directory-path>' }
      }
      const resolvedDir = resolve(getCwd(), rawDir)
      getCommandRuntime(context).setAppState?.(prev => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdates(
          prev.toolPermissionContext,
          [
            {
              type: 'addDirectories',
              directories: [resolvedDir],
              destination: 'session',
            },
          ],
        ),
      }))
      return {
        type: 'text',
        value: `Added working directory to session permissions: ${resolvedDir}`,
      }
    },
  }),

  makePromptCommand({
    name: 'init',
    description: 'Initialize a CLAUDE.md / COPILOT.md project guide for this repo',
    template:
      'Analyze this repository structure, build/test commands, and conventions, then propose a concise project guide (CLAUDE.md) covering architecture, key workflows, and gotchas.',
  }),

  makeLocalCommand({
    name: 'plan',
    description: 'Enter read-only Plan Mode to design changes before editing',
    argumentHint: '[goal]',
    call: async (args, context) => {
      getCommandRuntime(context).setAppState?.(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          mode: 'plan',
        },
      }))
      return {
        type: 'text',
        value: args.trim()
          ? `Entered plan mode for: ${args.trim()}`
          : 'Entered plan mode (read-only analysis until plan is approved).',
      }
    },
  }),

  makeLocalJsxCommand({
    name: 'memory',
    description: 'Inspect and configure project instructions and persistent memory',
    call: async onDone => (
      <MemoryFileSelector
        onSelect={selectedPath =>
          onDone(`Memory path: ${selectedPath}`)
        }
        onOpenFolder={folderPath =>
          onDone(`Memory folder: ${folderPath}`)
        }
        onCancel={() => onDone()}
      />
    ),
  }),
]
