import type {
  Command,
  LocalJsxCommandContext,
  LocalJsxCommandOnDone,
} from '../../types/command.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isImmediateCommand } from '../immediate_command.js'
import type { MessageQueueManager } from '../message_queue_manager.js'
import { isSlashCommandInput } from '../slash_command_parsing.js'
import {
  type BashCommandResult,
  type BashExecutorFn,
  processBashCommand,
} from './process_bash_command.js'
import {
  processSlashCommand,
  type SlashCommandExecutionResult,
} from './process_slash_command.js'
import {
  type ProcessedTextPrompt,
  processTextPrompt,
} from './process_text_prompt.js'

export type UserInputRouteResult =
  | { kind: 'empty' }
  | { kind: 'queued'; queueId: string; text: string }
  | { kind: 'bash'; result: BashCommandResult }
  | { kind: 'slash'; result: SlashCommandExecutionResult }
  | { kind: 'prompt'; result: ProcessedTextPrompt }

/**
 * Unified input router for the interactive REPL:
 * - While streaming: immediate commands run immediately; all other prompts are
 *   enqueued in `queueManager` so the user can type ahead smoothly.
 * - `!cmd` -> shell execution (`processBashCommand`)
 * - `/cmd` -> Slash command dispatch (`processSlashCommand`)
 * - Normal prompt -> paste/image expansion + `UserPromptSubmit` hooks (`processTextPrompt`)
 */
export async function processUserInput(params: {
  input: string
  commands: readonly Command[]
  context: LocalJsxCommandContext
  isLoading?: boolean
  queueManager?: MessageQueueManager
  permissionMode?: PermissionMode
  cwd?: string
  signal?: AbortSignal
  skipHooks?: boolean
  bashExecutor?: BashExecutorFn
  onLocalJsxDone?: LocalJsxCommandOnDone
}): Promise<UserInputRouteResult> {
  const trimmed = params.input.trim()
  if (!trimmed) {
    return { kind: 'empty' }
  }

  const isBash = trimmed.startsWith('!')
  const isSlash = !isBash && isSlashCommandInput(trimmed)

  if (
    params.isLoading &&
    params.queueManager &&
    !(isSlash && isImmediateCommand(trimmed, params.commands))
  ) {
    const mode = isBash ? 'bash' : isSlash ? 'command' : 'prompt'
    const item = params.queueManager.enqueue(trimmed, mode)
    return { kind: 'queued', queueId: item.id, text: item.text }
  }

  if (isBash) {
    const result = await processBashCommand(trimmed, {
      cwd: params.cwd,
      signal: params.signal,
      executor: params.bashExecutor,
    })
    return { kind: 'bash', result }
  }

  if (isSlash) {
    const result = await processSlashCommand({
      input: trimmed,
      commands: params.commands,
      context: params.context,
      onLocalJsxDone: params.onLocalJsxDone,
    })
    return { kind: 'slash', result }
  }

  const result = await processTextPrompt({
    rawInput: params.input,
    permissionMode: params.permissionMode,
    toolUseContext: params.context,
    signal: params.signal,
    skipHooks: params.skipHooks,
  })
  return { kind: 'prompt', result }
}
