/**
 * Attachment pipeline: discriminated attachment union, `<system-reminder>`
 * wrapping, 3-tier `getAttachments()` with 1s timeout & `maybe()` error
 * isolation, plus `@file` and `@agent` mention parsers.
 */

import { dirname, isAbsolute, relative, resolve } from 'path'
import {
  getLastEmittedDate,
  getTotalCostUsd,
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setLastEmittedDate,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../bootstrap/state.js'
import { getLocalIsoDate } from '../constants/common.js'
import type { QuerySource } from '../constants/query_source.js'
import type { ToolUseContext } from '../types/forward.js'
import type {
  AttachmentMessage,
  Message,
  UserMessage,
} from '../types/message.js'
import type { QueuedCommand } from '../types/text_input_types.js'
import { createChildAbortController } from './abort_controller.js'
import {
  getConditionalRulesForCwdLevelDirectory,
  getManagedAndUserConditionalRules,
  getMemoryFilesForNestedDirectory,
  type MemoryFileInfo,
} from './claudemd.js'
import { calculateTokenWarningState } from './context.js'
import { randomUUID } from './crypto.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './env_utils.js'
import { getInitialSettings } from './settings/settings.js'
import { hasUltrathinkKeyword, isUltrathinkEnabled } from './thinking.js'
import { tokenCountFromLastApiResponse } from './tokens.js'

const ATTACHMENTS_TIMEOUT_MS = 1_000

export type CoreAttachment =
  | { type: 'queued_command'; prompt: string | unknown[]; sourceUuid?: string; origin?: UserMessage['origin'] }
  | { type: 'date_change'; newDate: string }
  | { type: 'nested_memory'; content: MemoryFileInfo }
  | { type: 'critical_system_reminder'; content: string }
  | { type: 'output_style'; style: string }
  | { type: 'token_usage'; used: number; total: number; remaining: number }
  | { type: 'budget_usd'; used: number; total: number; remaining: number }
  | { type: 'output_token_usage'; used: number; total: number }
  | { type: 'ultrathink_effort'; level: 'high' }
  | { type: 'plan_mode_exit'; planFilePath?: string }
  | { type: 'auto_mode_exit' }
  | { type: 'max_turns_reached'; maxTurns: number; turnCount: number }
  | { type: 'structured_output'; data: unknown }
  | { type: 'hook_stopped_continuation'; reason?: string }
  | { type: 'file'; filename: string; content: string; truncated?: boolean }
  | { type: 'directory'; path: string; content: string }
  | { type: 'compact_file_reference'; filename: string }
  | { type: 'already_read_file'; filename: string }
  | { type: 'edited_text_file'; filename: string; snippet: string }
  | { type: 'edited_image_file'; filename: string }
  | { type: 'mcp_resource'; server: string; uri: string; content: string }
  | { type: 'hook_additional_context'; content: string[]; hookName: string }
  | { type: 'hook_blocking_error'; blockingError: { command: string; blockingError: string } }
  | { type: string; [key: string]: unknown }

/**
 * Wraps a text payload in `<system-reminder>...</system-reminder>` tags.
 */
export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}

/**
 * Wraps string or text blocks of user messages in `<system-reminder>` tags.
 */
export function wrapMessagesInSystemReminder(
  messages: readonly UserMessage[],
): UserMessage[] {
  return messages.map(msg => {
    const content = msg.message.content
    if (typeof content === 'string') {
      return {
        ...msg,
        message: {
          ...msg.message,
          content: wrapInSystemReminder(content),
        },
      }
    }
    if (Array.isArray(content)) {
      return {
        ...msg,
        message: {
          ...msg.message,
          content: content.map(block =>
            block.type === 'text'
              ? { ...block, text: wrapInSystemReminder(block.text) }
              : block,
          ),
        },
      }
    }
    return msg
  })
}

/**
 * Creates a timestamped `AttachmentMessage` wrapper.
 */
export function createAttachmentMessage<AttachmentType extends CoreAttachment>(
  attachment: AttachmentType,
): AttachmentMessage<AttachmentType> {
  return {
    type: 'attachment',
    attachment,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Extracts `@path` and `@"path with spaces"` file mention tokens from input text.
 */
export function extractAtMentionedFiles(input: string): string[] {
  const results: string[] = []
  const regex = /(?:^|\s)@(?:"([^"]+)"|([^\s@#]+(?:#L\d+(?:-\d+)?)?))/g
  let match = regex.exec(input)
  while (match !== null) {
    const candidate = match[1] ?? match[2] ?? ''
    if (candidate && !candidate.startsWith('agent-')) {
      results.push(candidate)
    }
    match = regex.exec(input)
  }
  return results
}

/**
 * Parses optional `#L10-20` line range suffix from an `@file` mention.
 */
export function parseAtMentionedFileLines(mention: string): {
  filename: string
  lineStart?: number
  lineEnd?: number
} {
  const lineMatch = mention.match(/^(.*)#L(\d+)(?:-(\d+))?$/)
  if (!lineMatch) {
    return { filename: mention }
  }
  const lineStart = Number(lineMatch[2])
  const lineEnd = lineMatch[3] ? Number(lineMatch[3]) : lineStart
  return {
    filename: lineMatch[1]!,
    lineStart,
    lineEnd,
  }
}

/**
 * Extracts `@agent-<type>` mentions from user input text.
 */
export function extractAgentMentions(input: string): string[] {
  const results: string[] = []
  const regex = /(?:^|\s)@agent-([a-zA-Z0-9_:-]+)/g
  let match = regex.exec(input)
  while (match !== null) {
    if (match[1]) {
      results.push(match[1])
    }
    match = regex.exec(input)
  }
  return results
}

function getQueuedCommandAttachments(
  queuedCommands: readonly QueuedCommand[],
): CoreAttachment[] {
  const attachments: CoreAttachment[] = []
  for (const cmd of queuedCommands) {
    if (cmd.value !== undefined) {
      attachments.push({
        type: 'queued_command',
        prompt: cmd.value,
        ...(cmd.uuid ? { sourceUuid: cmd.uuid } : {}),
        ...(cmd.origin ? { origin: cmd.origin } : {}),
      })
    }
  }
  return attachments
}

function getDateChangeAttachment(): CoreAttachment[] {
  const today = getLocalIsoDate()
  const lastEmitted = getLastEmittedDate()
  setLastEmittedDate(today)
  if (lastEmitted !== null && lastEmitted !== today) {
    return [{ type: 'date_change', newDate: today }]
  }
  return []
}

function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): CoreAttachment[] {
  const triggers = toolUseContext.nestedMemoryAttachmentTriggers as
    | Set<string>
    | undefined
  const loadedPaths = toolUseContext.loadedNestedMemoryPaths as
    | Set<string>
    | undefined
  if (!triggers || triggers.size === 0 || !loadedPaths) {
    return []
  }

  const cwd = resolve(getCwd())
  const attachments: CoreAttachment[] = []
  const pendingPaths = Array.from(triggers)
  triggers.clear()

  for (const rawTarget of pendingPaths) {
    const absTarget = resolve(cwd, rawTarget)
    const managedAndUser = getManagedAndUserConditionalRules(
      absTarget,
      loadedPaths,
    )
    for (const file of managedAndUser) {
      attachments.push({ type: 'nested_memory', content: file })
    }

    const rel = relative(cwd, absTarget)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      continue
    }

    // Check CWD-level conditional rules
    for (const file of getConditionalRulesForCwdLevelDirectory(
      cwd,
      absTarget,
      loadedPaths,
    )) {
      attachments.push({ type: 'nested_memory', content: file })
    }

    // Walk nested directories between cwd and dirname(absTarget)
    const nestedDirs: string[] = []
    let cursor = dirname(absTarget)
    while (cursor !== cwd && !relative(cwd, cursor).startsWith('..')) {
      nestedDirs.push(cursor)
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    for (const dir of nestedDirs.reverse()) {
      for (const file of getMemoryFilesForNestedDirectory(
        dir,
        absTarget,
        loadedPaths,
      )) {
        attachments.push({ type: 'nested_memory', content: file })
      }
    }
  }

  return attachments
}

async function maybe(
  label: string,
  fn: () => CoreAttachment[] | Promise<CoreAttachment[]>,
): Promise<CoreAttachment[]> {
  try {
    return await fn()
  } catch (error) {
    logForDebugging(`Attachment generator "${label}" failed: ${String(error)}`)
    return []
  }
}

export interface GetAttachmentsOptions {
  maxBudgetUsd?: number
  mainLoopModel?: string
}

/**
 * Evaluates all active attachment generators in 3 tiers with error isolation
 * and a 1000ms child abort timeout.
 */
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  _ideSelection?: unknown,
  queuedCommands: readonly QueuedCommand[] = [],
  messages: readonly Message[] = [],
  _querySource?: QuerySource,
  options?: GetAttachmentsOptions,
): Promise<CoreAttachment[]> {
  if (
    isEnvTruthy(process.env.COPILOT_CLI_DISABLE_ATTACHMENTS) ||
    isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)
  ) {
    return getQueuedCommandAttachments(queuedCommands)
  }

  const childAbort = createChildAbortController(toolUseContext.abortController)
  const timeoutId = setTimeout(() => {
    childAbort.abort(new Error('Attachment timeout'))
  }, ATTACHMENTS_TIMEOUT_MS)
  timeoutId.unref?.()

  try {
    // Tier 1: user-input derived attachments (runs before nested memory)
    const tier1: CoreAttachment[] = []
    if (input) {
      if (isUltrathinkEnabled() && hasUltrathinkKeyword(input)) {
        tier1.push({ type: 'ultrathink_effort', level: 'high' })
      }
    }

    // Tier 2 (all threads) + Tier 3 (main thread only) in parallel
    const isMainThread = !toolUseContext.agentId
    const parallelTasks: Array<Promise<CoreAttachment[]>> = [
      maybe('queued_commands', () =>
        getQueuedCommandAttachments(queuedCommands),
      ),
      maybe('date_change', () => getDateChangeAttachment()),
      maybe('nested_memory', () => getNestedMemoryAttachments(toolUseContext)),
      maybe('critical_system_reminder', () => {
        const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
        return typeof reminder === 'string' && reminder.trim().length > 0
          ? [{ type: 'critical_system_reminder', content: reminder }]
          : []
      }),
      maybe('plan_mode_exit', () => {
        if (!needsPlanModeExitAttachment()) return []
        setNeedsPlanModeExitAttachment(false)
        return [{ type: 'plan_mode_exit' }]
      }),
      maybe('auto_mode_exit', () => {
        if (!needsAutoModeExitAttachment()) return []
        setNeedsAutoModeExitAttachment(false)
        return [{ type: 'auto_mode_exit' }]
      }),
    ]

    if (isMainThread) {
      parallelTasks.push(
        maybe('output_style', () => {
          const style = getInitialSettings().outputStyle
          return style && style !== 'default'
            ? [{ type: 'output_style', style }]
            : []
        }),
        maybe('token_usage', () => {
          if (messages.length === 0 || !options?.mainLoopModel) return []
          const used = tokenCountFromLastApiResponse(messages)
          if (used <= 0) return []
          const warning = calculateTokenWarningState(used, options.mainLoopModel)
          if (!warning.isAboveWarningThreshold) return []
          return [
            {
              type: 'token_usage',
              used,
              total: used + Math.round((used * warning.percentLeft) / Math.max(1, 100 - warning.percentLeft)),
              remaining: warning.percentLeft,
            },
          ]
        }),
        maybe('budget_usd', () => {
          if (options?.maxBudgetUsd === undefined || options.maxBudgetUsd <= 0) {
            return []
          }
          const used = getTotalCostUsd()
          if (used <= 0) return []
          return [
            {
              type: 'budget_usd',
              used,
              total: options.maxBudgetUsd,
              remaining: Math.max(0, options.maxBudgetUsd - used),
            },
          ]
        }),
      )
    }

    const batches = await Promise.all(parallelTasks)
    return [...tier1, ...batches.flat()]
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * AsyncGenerator yielding wrapped `AttachmentMessage`s from `getAttachments`.
 */
export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection?: unknown,
  queuedCommands: readonly QueuedCommand[] = [],
  messages: readonly Message[] = [],
  querySource?: QuerySource,
  options?: GetAttachmentsOptions,
): AsyncGenerator<AttachmentMessage<CoreAttachment>, void> {
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )
  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}
