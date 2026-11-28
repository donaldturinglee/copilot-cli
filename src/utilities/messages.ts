/**
 * Core message constructors, normalization pipeline (`normalizeMessagesForApi`),
 * `ensureToolResultPairing`, media/image validation, compaction boundary
 * slicing, and content extraction utilities.
 */

import type { APIError } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import { getStrictToolResultPairing } from '../bootstrap/state.js'
import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/api_limits.js'
import { NO_CONTENT_MESSAGE } from '../constants/messages.js'
import { memoryFreshnessText } from '../memdir/memory_age.js'
import { EMPTY_USAGE } from '../services/api/empty_usage.js'
import type {
  Attachment,
  Progress,
  SdkAssistantMessageError,
  Tool,
} from '../types/forward.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  CompactMetadata,
  Message,
  MessageOrigin,
  NormalizedMessage,
  ProgressMessage,
  SystemApiErrorMessage,
  SystemCompactBoundaryMessage,
  SystemInformationalMessage,
  SystemLocalCommandMessage,
  SystemMessageLevel,
  SystemMicrocompactBoundaryMessage,
  SystemTurnDurationMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../types/message.js'
import type { PermissionMode } from '../types/permissions.js'
import { wrapInSystemReminder, type CoreAttachment } from './attachments.js'
import type { MemoryFileInfo } from './claudemd.js'
import { randomUUID } from './crypto.js'

export const SYNTHETIC_MODEL = '<synthetic>'
export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'
export const CANCEL_MESSAGE = '[Request cancelled by user]'
export const REJECT_MESSAGE = 'The user rejected the tool call.'
export const NO_RESPONSE_REQUESTED = 'No response requested.'
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'

export const SYNTHETIC_MESSAGES: ReadonlySet<string> = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
])

/**
 * Thrown when an inline base64 image block exceeds the 5 MB API limit.
 */
export class ImageSizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageSizeError'
  }
}

/**
 * Thrown when image resizing/normalization fails prior to API transmission.
 */
export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

function asBetaUsage(usage: typeof EMPTY_USAGE): BetaUsage {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens,
    },
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    server_tool_use: {
      web_search_requests: usage.server_tool_use.web_search_requests,
    },
    service_tier: usage.service_tier,
  }
}

// =============================================================================
// Message Creators
// =============================================================================

export interface CreateUserMessageParams {
  content: MessageParam['content']
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  summarizeMetadata?: UserMessage['summarizeMetadata']
  toolUseResult?: unknown
  mcpMeta?: UserMessage['mcpMeta']
  uuid?: UUID
  timestamp?: string
  imagePasteIds?: number[]
  sourceToolAssistantUuid?: UUID
  sourceToolUseId?: string
  permissionMode?: PermissionMode
  origin?: MessageOrigin
  planContent?: string
}

/**
 * Creates a normalized internal `UserMessage`, substituting `NO_CONTENT_MESSAGE`
 * when `content` is empty.
 */
export function createUserMessage(params: CreateUserMessageParams): UserMessage {
  const content =
    params.content === '' ||
    (Array.isArray(params.content) && params.content.length === 0)
      ? NO_CONTENT_MESSAGE
      : params.content
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    uuid: params.uuid ?? randomUUID(),
    timestamp: params.timestamp ?? new Date().toISOString(),
    ...(params.isMeta ? { isMeta: true } : {}),
    ...(params.isVisibleInTranscriptOnly
      ? { isVisibleInTranscriptOnly: true }
      : {}),
    ...(params.isVirtual ? { isVirtual: true } : {}),
    ...(params.isCompactSummary ? { isCompactSummary: true } : {}),
    ...(params.summarizeMetadata
      ? { summarizeMetadata: params.summarizeMetadata }
      : {}),
    ...(params.toolUseResult !== undefined
      ? { toolUseResult: params.toolUseResult }
      : {}),
    ...(params.mcpMeta ? { mcpMeta: params.mcpMeta } : {}),
    ...(params.imagePasteIds ? { imagePasteIds: params.imagePasteIds } : {}),
    ...(params.sourceToolAssistantUuid
      ? { sourceToolAssistantUuid: params.sourceToolAssistantUuid }
      : {}),
    ...(params.sourceToolUseId
      ? { sourceToolUseId: params.sourceToolUseId }
      : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.planContent ? { planContent: params.planContent } : {}),
  }
}

/**
 * Creates a synthetic `AssistantMessage` (`model: '<synthetic>'`).
 */
export function createAssistantMessage(params: {
  content: string | BetaContentBlock[]
  usage?: BetaUsage
  isVirtual?: true
  isMeta?: boolean
}): AssistantMessage {
  const blocks: BetaContentBlock[] =
    typeof params.content === 'string'
      ? [{ type: 'text', text: params.content, citations: [] }]
      : params.content
  return {
    type: 'assistant',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: SYNTHETIC_MODEL,
      content: blocks,
      stop_reason: 'stop_sequence',
      stop_sequence: null,
      usage: params.usage ?? asBetaUsage(EMPTY_USAGE),
      container: null,
    },
    requestId: undefined,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...(params.isVirtual ? { isVirtual: true } : {}),
    ...(params.isMeta ? { isMeta: params.isMeta } : {}),
  }
}

/**
 * Creates a synthetic assistant API error message (`isApiErrorMessage: true`).
 */
export function createAssistantApiErrorMessage(params: {
  content: string
  apiError?: 'max_output_tokens'
  error?: SdkAssistantMessageError
  errorDetails?: string
}): AssistantMessage {
  return {
    ...createAssistantMessage({ content: params.content }),
    isApiErrorMessage: true,
    ...(params.apiError ? { apiError: params.apiError } : {}),
    ...(params.error ? { error: params.error } : {}),
    ...(params.errorDetails ? { errorDetails: params.errorDetails } : {}),
  }
}

/**
 * Creates an informational system message.
 */
export function createSystemMessage(
  content: string,
  level: SystemMessageLevel,
  toolUseId?: string,
  preventContinuation?: boolean,
): SystemInformationalMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content,
    level,
    isMeta: false,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...(toolUseId ? { toolUseId } : {}),
    ...(preventContinuation !== undefined ? { preventContinuation } : {}),
  }
}

/**
 * Creates a system `api_error` message emitted while `withRetry` sleeps before retrying.
 */
export function createSystemApiErrorMessage(
  error: APIError,
  retryInMs: number,
  retryAttempt: number,
  maxRetries: number,
): SystemApiErrorMessage {
  return {
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    error,
    retryInMs,
    retryAttempt,
    maxRetries,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a `compact_boundary` system message marking a compaction checkpoint.
 */
export function createCompactBoundaryMessage(
  trigger: 'manual' | 'auto',
  preTokens: number,
  extra?: Partial<CompactMetadata>,
  logicalParentUuid?: UUID,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    isMeta: false,
    compactMetadata: {
      trigger,
      preTokens,
      ...extra,
    },
    ...(logicalParentUuid ? { logicalParentUuid } : {}),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a `microcompact_boundary` system message.
 */
export function createMicrocompactBoundaryMessage(
  preTokens: number,
  tokensSaved: number,
  compactedToolIds: string[],
  clearedAttachmentUuids: string[] = [],
): SystemMicrocompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'microcompact_boundary',
    content: 'Context microcompacted',
    level: 'info',
    isMeta: false,
    microcompactMetadata: {
      trigger: 'auto',
      preTokens,
      tokensSaved,
      compactedToolIds,
      clearedAttachmentUuids,
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a `local_command` system message preserved in API normalization.
 */
export function createCommandInputMessage(
  content: string,
  level: SystemMessageLevel = 'info',
): SystemLocalCommandMessage {
  return {
    type: 'system',
    subtype: 'local_command',
    content,
    level,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a `turn_duration` telemetry system message.
 */
export function createTurnDurationMessage(
  durationMs: number,
  extra?: Partial<
    Pick<
      SystemTurnDurationMessage,
      'budgetTokens' | 'budgetLimit' | 'budgetNudges' | 'messageCount'
    >
  >,
): SystemTurnDurationMessage {
  return {
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    ...extra,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a user interruption marker message.
 */
export function createUserInterruptionMessage(options: {
  toolUse: boolean
}): UserMessage {
  return createUserMessage({
    content: options.toolUse
      ? INTERRUPT_MESSAGE_FOR_TOOL_USE
      : INTERRUPT_MESSAGE,
  })
}

/**
 * Creates a `progress` message wrapper.
 */
export function createProgressMessage<P extends Progress>(params: {
  data: P
  toolUseId: string
  parentToolUseId: string
}): ProgressMessage<P> {
  return {
    type: 'progress',
    data: params.data,
    toolUseId: params.toolUseId,
    parentToolUseId: params.parentToolUseId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Creates a `tool_use_summary` message.
 */
export function createToolUseSummaryMessage(
  summary: string,
  precedingToolUseIds: string[],
): ToolUseSummaryMessage {
  return {
    type: 'tool_use_summary',
    summary,
    precedingToolUseIds,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

// =============================================================================
// Predicates & Extraction Helpers
// =============================================================================

export function isSyntheticApiErrorMessage(message: Message): boolean {
  return (
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    message.message.model === SYNTHETIC_MODEL
  )
}

export function isSyntheticMessage(message: Message): boolean {
  if (message.type !== 'user' && message.type !== 'assistant') {
    return false
  }
  const content = message.message.content
  if (typeof content === 'string') {
    return SYNTHETIC_MESSAGES.has(content)
  }
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0]
    if (first && first.type === 'text') {
      return SYNTHETIC_MESSAGES.has(first.text)
    }
  }
  return false
}

export function isCompactBoundaryMessage(
  message: Message,
): message is SystemCompactBoundaryMessage {
  return message.type === 'system' && message.subtype === 'compact_boundary'
}

export function findLastCompactBoundaryIndex(
  messages: readonly Message[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundaryMessage(messages[i]!)) {
      return i
    }
  }
  return -1
}

/**
 * Slices `messages` starting at the most recent `compact_boundary` marker (inclusive).
 */
export function getMessagesAfterCompactBoundary(
  messages: readonly Message[],
): Message[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  if (boundaryIndex === -1) {
    return [...messages]
  }
  return messages.slice(boundaryIndex)
}

/**
 * Extracts concatenated text from a `MessageParam['content']` or `BetaContentBlock[]`.
 */
export function extractTextContent(
  content: MessageParam['content'] | readonly BetaContentBlock[],
  separator = '\n',
): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const texts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && 'text' in block) {
      texts.push(String(block.text))
    }
  }
  return texts.join(separator)
}

export function getAssistantMessageText(message: AssistantMessage): string {
  return extractTextContent(message.message.content)
}

export function getUserMessageText(message: UserMessage): string {
  return extractTextContent(message.message.content)
}

export function isEmptyMessageText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length === 0 || trimmed === NO_CONTENT_MESSAGE
}

export function isNotEmptyMessage(message: Message): boolean {
  if (message.type === 'assistant') {
    if (message.message.content.length === 0) return false
    return message.message.content.some(block => {
      if (block.type === 'text') {
        return !isEmptyMessageText(block.text)
      }
      return true
    })
  }
  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') {
      return !isEmptyMessageText(content)
    }
    return content.length > 0
  }
  return true
}

/**
 * Extracts the inner text of an XML-like `<tagName>...</tagName>` block with
 * nesting awareness.
 */
export function extractTag(html: string, tagName: string): string | null {
  const openTag = `<${tagName}>`
  const closeTag = `</${tagName}>`
  const startIdx = html.indexOf(openTag)
  if (startIdx === -1) {
    return null
  }
  let depth = 1
  let cursor = startIdx + openTag.length
  while (cursor < html.length && depth > 0) {
    const nextOpen = html.indexOf(openTag, cursor)
    const nextClose = html.indexOf(closeTag, cursor)
    if (nextClose === -1) {
      return null
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++
      cursor = nextOpen + openTag.length
    } else {
      depth--
      if (depth === 0) {
        return html.slice(startIdx + openTag.length, nextClose)
      }
      cursor = nextClose + closeTag.length
    }
  }
  return null
}

/**
 * Derives a deterministic child UUID from a parent UUID and block index.
 */
export function deriveUuid(parentUuid: UUID, index: number): UUID {
  return `${parentUuid.slice(0, 24)}${index.toString(16).padStart(12, '0')}` as UUID
}

/**
 * Splits multi-block assistant messages into single-block normalized messages
 * with deterministic derived UUIDs.
 */
export function normalizeMessages(
  messages: readonly Message[],
): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      if (msg.message.content.length <= 1) {
        result.push(msg as NormalizedMessage)
      } else {
        msg.message.content.forEach((block, idx) => {
          result.push({
            ...msg,
            uuid: idx === 0 ? msg.uuid : deriveUuid(msg.uuid, idx),
            message: {
              ...msg.message,
              content: [block],
            },
          })
        })
      }
    } else if (msg.type === 'user') {
      const content =
        typeof msg.message.content === 'string'
          ? [{ type: 'text' as const, text: msg.message.content }]
          : msg.message.content
      result.push({
        ...msg,
        message: {
          role: 'user',
          content: content as Array<
            TextBlockParam | ImageBlockParam | ToolResultBlockParam
          >,
        },
      })
    } else {
      result.push(msg)
    }
  }
  return result
}

/**
 * Strips `thinking`, `redacted_thinking`, and `connector_text` blocks across
 * history (used when switching models or credentials).
 */
export function stripSignatureBlocks(messages: readonly Message[]): Message[] {
  return messages.map(msg => {
    if (msg.type !== 'assistant') {
      return msg
    }
    const filtered = msg.message.content.filter(block => {
      const type = (block as { type: string }).type
      return (
        type !== 'thinking' &&
        type !== 'redacted_thinking' &&
        type !== 'connector_text'
      )
    })
    if (filtered.length === msg.message.content.length) {
      return msg
    }
    return {
      ...msg,
      message: {
        ...msg.message,
        content:
          filtered.length > 0
            ? filtered
            : [{ type: 'text', text: NO_CONTENT_MESSAGE, citations: [] }],
      },
    }
  })
}

/**
 * Drops assistant messages whose `tool_use` blocks are all missing matching
 * `tool_result` responses.
 */
export function filterUnresolvedToolUses(
  messages: readonly Message[],
): Message[] {
  const resolvedToolUseIds = new Set<string>()
  for (const msg of messages) {
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          resolvedToolUseIds.add(block.tool_use_id)
        }
      }
    }
  }
  return messages.filter(msg => {
    if (msg.type !== 'assistant') {
      return true
    }
    const toolUses = msg.message.content.filter(b => b.type === 'tool_use')
    if (toolUses.length === 0) {
      return true
    }
    return toolUses.some(tu => resolvedToolUseIds.has(tu.id))
  })
}

/**
 * Parses streamed partial-JSON `tool_use` inputs into objects after
 * `content_block_stop`.
 */
export function normalizeContentFromApi(
  content: readonly BetaContentBlock[],
  _tools?: readonly Tool[],
  _agentId?: string,
): BetaContentBlock[] {
  return content.map(block => {
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      const rawInput = (block as { input?: unknown }).input
      if (typeof rawInput === 'string') {
        const trimmed = rawInput.trim()
        if (!trimmed) {
          return { ...block, input: {} } as BetaContentBlock
        }
        try {
          return { ...block, input: JSON.parse(trimmed) } as BetaContentBlock
        } catch {
          return { ...block, input: {} } as BetaContentBlock
        }
      }
    }
    return block
  })
}

// =============================================================================
// Attachment -> API UserMessage Normalization
// =============================================================================

/**
 * Converts an internal `Attachment` into API-ready `UserMessage[]` wrapped in
 * `<system-reminder>` tags (`[]` for UI-only or no-op attachments).
 */
export function normalizeAttachmentForApi(
  attachment: Attachment,
): UserMessage[] {
  const typed = attachment as CoreAttachment
  switch (typed.type) {
    case 'queued_command': {
      const prompt = typed.prompt as MessageParam['content']
      const origin = typed.origin as MessageOrigin | undefined
      const isHuman = origin?.kind === 'human'
      return [
        createUserMessage({
          content: prompt,
          ...(isHuman ? {} : { isMeta: true }),
          origin,
        }),
      ]
    }
    case 'date_change':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `The current date is now ${String(typed.newDate)}.`,
          ),
          isMeta: true,
        }),
      ]
    case 'nested_memory': {
      const file = typed.content as MemoryFileInfo
      if (!file?.content?.trim()) return []
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Contents of ${file.path}:\n\n${file.content}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'critical_system_reminder':
      return [
        createUserMessage({
          content: wrapInSystemReminder(String(typed.content)),
          isMeta: true,
        }),
      ]
    case 'output_style':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Active output style: ${String(typed.style)}.`,
          ),
          isMeta: true,
        }),
      ]
    case 'token_usage':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Token usage: ${typed.used}/${typed.total}; ${typed.remaining}% remaining.`,
          ),
          isMeta: true,
        }),
      ]
    case 'budget_usd':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `USD budget: $${Number(typed.used).toFixed(4)} / $${Number(typed.total).toFixed(2)} ($${Number(typed.remaining).toFixed(4)} remaining).`,
          ),
          isMeta: true,
        }),
      ]
    case 'ultrathink_effort':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            'The user requested deep reasoning (ultrathink). Think thoroughly before responding.',
          ),
          isMeta: true,
        }),
      ]
    case 'plan_mode_exit':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            'Exited plan mode. You may now proceed with implementation.',
          ),
          isMeta: true,
        }),
      ]
    case 'auto_mode_exit':
      return [
        createUserMessage({
          content: wrapInSystemReminder('Exited auto permission mode.'),
          isMeta: true,
        }),
      ]
    case 'file':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Referenced file ${String(typed.filename)}:\n\n${String(typed.content)}`,
          ),
          isMeta: true,
        }),
      ]
    case 'directory':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Directory listing for ${String(typed.path)}:\n\n${String(typed.content)}`,
          ),
          isMeta: true,
        }),
      ]
    case 'edited_text_file':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Note: ${String(typed.filename)} was modified externally:\n${String(typed.snippet)}`,
          ),
          isMeta: true,
        }),
      ]
    case 'mcp_resource':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `MCP resource ${String(typed.server)}:${String(typed.uri)}:\n${String(typed.content)}`,
          ),
          isMeta: true,
        }),
      ]
    case 'hook_additional_context': {
      const lines = Array.isArray(typed.content) ? typed.content : []
      if (lines.length === 0) return []
      return [
        createUserMessage({
          content: wrapInSystemReminder(lines.join('\n')),
          isMeta: true,
        }),
      ]
    }
    case 'hook_blocking_error': {
      const errObj = typed.blockingError as
        | { command?: string; blockingError?: string }
        | undefined
      if (!errObj?.blockingError) return []
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Hook ${errObj.command ?? ''} blocked continuation: ${errObj.blockingError}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'relevant_memories': {
      const memories = Array.isArray(typed.memories)
        ? (typed.memories as Array<{
            path: string
            content: string
            mtimeMs: number
          }>)
        : []
      if (memories.length === 0) return []
      const sections = memories.map(mem => {
        const freshness = memoryFreshnessText(mem.mtimeMs)
        const note = freshness ? `\n${freshness}` : ''
        return `Relevant memory (${mem.path}):${note}\n\n${mem.content}`
      })
      return [
        createUserMessage({
          content: wrapInSystemReminder(sections.join('\n\n---\n\n')),
          isMeta: true,
        }),
      ]
    }
    case 'plan_file_reference': {
      const planPath = String(typed.planFilePath ?? '')
      const planContent = String(typed.planContent ?? '')
      if (!planContent.trim()) return []
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Active plan file (${planPath}):\n\n${planContent}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'plan_mode': {
      const planPath = typed.planFilePath
        ? ` Plan file: ${String(typed.planFilePath)}.`
        : ''
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Plan mode is active.${planPath} Avoid mutating project files until the plan is approved.`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'invoked_skills': {
      const skills = Array.isArray(typed.skills)
        ? (typed.skills as Array<{ name: string; path: string; content: string }>)
        : []
      if (skills.length === 0) return []
      const body = skills
        .map(s => `Skill "${s.name}" (${s.path}):\n\n${s.content}`)
        .join('\n\n---\n\n')
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Previously invoked skills preserved across compaction:\n\n${body}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'task_status': {
      const tasks = Array.isArray(typed.tasks)
        ? (typed.tasks as Array<{ id: string; subject: string; status: string }>)
        : []
      if (tasks.length === 0) return []
      const lines = tasks.map(t => `- [${t.status}] #${t.id}: ${t.subject}`)
      return [
        createUserMessage({
          content: wrapInSystemReminder(`Active tasks:\n${lines.join('\n')}`),
          isMeta: true,
        }),
      ]
    }
    // UI-only / terminal / legacy no-op attachments
    case 'already_read_file':
    case 'command_permissions':
    case 'edited_image_file':
    case 'dynamic_skill':
    case 'structured_output':
    case 'max_turns_reached':
    case 'hook_stopped_continuation':
    case 'hook_cancelled':
    case 'hook_error_during_execution':
    case 'hook_non_blocking_error':
    case 'hook_system_message':
    case 'hook_permission_decision':
    default:
      return []
  }
}

// =============================================================================
// API Normalization Pipeline (`normalizeMessagesForApi` + `ensureToolResultPairing`)
// =============================================================================

function toBlockArray(content: MessageParam['content']): ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return [...content]
}

function hoistToolResults(blocks: ContentBlockParam[]): ContentBlockParam[] {
  const toolResults: ContentBlockParam[] = []
  const others: ContentBlockParam[] = []
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      toolResults.push(block)
    } else {
      others.push(block)
    }
  }
  return [...toolResults, ...others]
}

function joinTextAtSeam(
  first: ContentBlockParam[],
  second: ContentBlockParam[],
): ContentBlockParam[] {
  if (first.length === 0) return [...second]
  if (second.length === 0) return [...first]
  const lastFirst = first[first.length - 1]
  const firstSecond = second[0]
  if (lastFirst?.type === 'text' && firstSecond?.type === 'text') {
    const copy = [...first]
    copy[copy.length - 1] = {
      ...lastFirst,
      text: `${lastFirst.text}\n`,
    }
    return [...copy, ...second]
  }
  return [...first, ...second]
}

function mergeUserMessages(a: UserMessage, b: UserMessage): UserMessage {
  const merged = hoistToolResults(
    joinTextAtSeam(
      toBlockArray(a.message.content),
      toBlockArray(b.message.content),
    ),
  )
  return {
    ...a,
    uuid: a.isMeta ? b.uuid : a.uuid,
    isMeta: a.isMeta && b.isMeta ? true : undefined,
    message: {
      role: 'user',
      content: merged,
    },
  }
}

function isToolResultUserMessage(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message.content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content[0]?.type === 'tool_result'
  )
}

/**
 * Bubbles `attachment` messages upward across adjacent user text messages until
 * hitting an assistant message or a user `tool_result` message (O(N) reverse pass).
 */
function reorderAttachmentsForApi(messages: readonly Message[]): Message[] {
  const reversed: Message[] = []
  const pendingAttachments: AttachmentMessage[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'attachment') {
      pendingAttachments.push(msg)
      continue
    }
    if (
      pendingAttachments.length > 0 &&
      (msg.type === 'assistant' || isToolResultUserMessage(msg))
    ) {
      while (pendingAttachments.length > 0) {
        reversed.push(pendingAttachments.pop()!)
      }
    }
    reversed.push(msg)
  }

  while (pendingAttachments.length > 0) {
    reversed.push(pendingAttachments.pop()!)
  }

  return reversed.reverse()
}

function isThinkingOnlyAssistant(msg: AssistantMessage): boolean {
  return (
    msg.message.content.length > 0 &&
    msg.message.content.every(
      b => b.type === 'thinking' || b.type === 'redacted_thinking',
    )
  )
}

function isWhitespaceOnlyAssistant(msg: AssistantMessage): boolean {
  return (
    msg.message.content.length > 0 &&
    msg.message.content.every(
      b => b.type === 'text' && b.text.trim().length === 0,
    )
  )
}

function sanitizeErrorToolResultContent(
  messages: Array<UserMessage | AssistantMessage>,
): Array<UserMessage | AssistantMessage> {
  return messages.map(msg => {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) {
      return msg
    }
    let modified = false
    const nextContent = msg.message.content.map(block => {
      if (
        block.type === 'tool_result' &&
        block.is_error === true &&
        Array.isArray(block.content)
      ) {
        const textOnly = block.content.filter(nested => nested.type === 'text')
        if (textOnly.length !== block.content.length) {
          modified = true
          return {
            ...block,
            content:
              textOnly.length > 0
                ? textOnly
                : [{ type: 'text' as const, text: 'Error' }],
          }
        }
      }
      return block
    })
    return modified
      ? { ...msg, message: { ...msg.message, content: nextContent } }
      : msg
  })
}

function validateImagesForApi(
  messages: ReadonlyArray<UserMessage | AssistantMessage>,
): void {
  const checkBlock = (block: unknown): void => {
    if (!block || typeof block !== 'object') return
    const record = block as Record<string, unknown>
    if (record.type === 'image' && record.source && typeof record.source === 'object') {
      const source = record.source as { type?: unknown; data?: unknown }
      if (
        source.type === 'base64' &&
        typeof source.data === 'string' &&
        source.data.length > API_IMAGE_MAX_BASE64_SIZE
      ) {
        throw new ImageSizeError(
          `Image base64 payload (${source.data.length} bytes) exceeds maximum allowed size (${API_IMAGE_MAX_BASE64_SIZE} bytes).`,
        )
      }
    } else if (record.type === 'tool_result' && Array.isArray(record.content)) {
      for (const nested of record.content) {
        checkBlock(nested)
      }
    }
  }

  for (const msg of messages) {
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        checkBlock(block)
      }
    }
  }
}

/**
 * Strips `tool_reference` blocks from user messages (when tool search is off).
 */
export function stripToolReferenceBlocksFromUserMessage(
  msg: UserMessage,
): UserMessage {
  if (!Array.isArray(msg.message.content)) {
    return msg
  }
  let changed = false
  const nextContent = msg.message.content.map(block => {
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const filtered = block.content.filter(
        nested => (nested as { type?: string }).type !== 'tool_reference',
      )
      if (filtered.length !== block.content.length) {
        changed = true
        return {
          ...block,
          content:
            filtered.length > 0
              ? filtered
              : [
                  {
                    type: 'text' as const,
                    text: '[Tool references removed]',
                  },
                ],
        }
      }
    }
    return block
  })
  return changed
    ? { ...msg, message: { ...msg.message, content: nextContent } }
    : msg
}

/**
 * Strips `caller` metadata from assistant `tool_use` blocks (when tool search is off).
 */
export function stripCallerFieldFromAssistantMessage(
  msg: AssistantMessage,
): AssistantMessage {
  let changed = false
  const nextContent = msg.message.content.map(block => {
    if (block.type === 'tool_use' && 'caller' in block) {
      changed = true
      const copy = { ...(block as unknown as Record<string, unknown>) }
      delete copy.caller
      return copy as unknown as BetaContentBlock
    }
    return block
  })
  return changed
    ? { ...msg, message: { ...msg.message, content: nextContent } }
    : msg
}

/**
 * Strips server-side advisor blocks from assistant messages when the advisor
 * beta header is not enabled.
 */
export function stripAdvisorBlocks(
  messages: ReadonlyArray<UserMessage | AssistantMessage>,
): Array<UserMessage | AssistantMessage> {
  return messages.map(msg => {
    if (msg.type !== 'assistant') {
      return msg
    }
    const filtered = msg.message.content.filter(block => {
      const rec = block as { type?: string; name?: string }
      return !(
        (rec.type === 'server_tool_use' && rec.name === 'advisor') ||
        rec.type === 'advisor_tool_result'
      )
    })
    if (filtered.length === msg.message.content.length) {
      return msg
    }
    return {
      ...msg,
      message: {
        ...msg.message,
        content:
          filtered.length > 0
            ? filtered
            : [{ type: 'text', text: NO_CONTENT_MESSAGE, citations: [] }],
      },
    }
  })
}

/**
 * Normalizes internal conversation messages into clean alternating API messages:
 * bubbles attachments, drops virtual/progress/synthetic-error entries, merges
 * adjacent user messages (hoisting `tool_result` blocks first), coalesces split
 * assistant blocks sharing `message.id`, strips orphaned/trailing thinking and
 * whitespace-only assistants, sanitizes error `tool_result`s, and validates
 * image sizes.
 */
export function normalizeMessagesForApi(
  messages: readonly Message[],
  _tools?: readonly Tool[],
): Array<UserMessage | AssistantMessage> {
  const reordered = reorderAttachmentsForApi(messages)
  const output: Array<UserMessage | AssistantMessage> = []

  const pushUser = (userMsg: UserMessage): void => {
    const prev = output[output.length - 1]
    if (prev?.type === 'user') {
      output[output.length - 1] = mergeUserMessages(prev, userMsg)
    } else {
      output.push({
        ...userMsg,
        message: {
          role: 'user',
          content: Array.isArray(userMsg.message.content)
            ? hoistToolResults([...userMsg.message.content])
            : userMsg.message.content,
        },
      })
    }
  }

  for (const msg of reordered) {
    if (
      (msg.type === 'user' || msg.type === 'assistant') &&
      msg.isVirtual === true
    ) {
      continue
    }
    if (msg.type === 'progress') {
      continue
    }
    if (isSyntheticApiErrorMessage(msg)) {
      continue
    }
    if (msg.type === 'system') {
      if (msg.subtype === 'local_command') {
        pushUser(
          createUserMessage({
            content: msg.content,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
          }),
        )
      }
      continue
    }
    if (msg.type === 'attachment') {
      const expanded = normalizeAttachmentForApi(msg.attachment)
      for (const expandedUser of expanded) {
        pushUser(expandedUser)
      }
      continue
    }
    if (msg.type === 'user') {
      pushUser(msg)
      continue
    }
    if (msg.type === 'assistant') {
      // Walk backward over assistants or tool_result user messages to merge
      // split streaming blocks that share the same `message.id`.
      let mergeIdx = -1
      for (let i = output.length - 1; i >= 0; i--) {
        const candidate = output[i]!
        if (
          candidate.type === 'assistant' &&
          candidate.message.id === msg.message.id &&
          msg.message.id
        ) {
          mergeIdx = i
          break
        }
        if (
          candidate.type !== 'assistant' &&
          !isToolResultUserMessage(candidate)
        ) {
          break
        }
      }

      if (mergeIdx >= 0) {
        const existing = output[mergeIdx] as AssistantMessage
        output[mergeIdx] = {
          ...existing,
          message: {
            ...existing.message,
            content: [...existing.message.content, ...msg.message.content],
            usage: msg.message.usage ?? existing.message.usage,
            stop_reason: msg.message.stop_reason ?? existing.message.stop_reason,
          },
        }
      } else {
        output.push({
          ...msg,
          message: {
            ...msg.message,
            content: [...msg.message.content],
          },
        })
      }
    }
  }

  // Post-pass 1: Drop orphaned thinking-only assistants (unless sibling shares message.id)
  const nonThinkingMessageIds = new Set<string>()
  for (const msg of output) {
    if (msg.type === 'assistant' && !isThinkingOnlyAssistant(msg)) {
      nonThinkingMessageIds.add(msg.message.id)
    }
  }
  let cleaned = output.filter(msg => {
    if (msg.type === 'assistant' && isThinkingOnlyAssistant(msg)) {
      return nonThinkingMessageIds.has(msg.message.id)
    }
    return true
  })

  // Post-pass 2: Trim trailing thinking blocks on final assistant message
  const lastIdx = cleaned.length - 1
  if (lastIdx >= 0 && cleaned[lastIdx]!.type === 'assistant') {
    const lastAssistant = cleaned[lastIdx] as AssistantMessage
    const content = [...lastAssistant.message.content]
    while (
      content.length > 0 &&
      (content[content.length - 1]!.type === 'thinking' ||
        content[content.length - 1]!.type === 'redacted_thinking')
    ) {
      content.pop()
    }
    if (content.length !== lastAssistant.message.content.length) {
      cleaned[lastIdx] = {
        ...lastAssistant,
        message: {
          ...lastAssistant.message,
          content:
            content.length > 0
              ? content
              : [{ type: 'text', text: '[No message content]', citations: [] }],
        },
      }
    }
  }

  // Post-pass 3: Filter whitespace-only assistant messages and re-merge newly adjacent users
  const afterWhitespace: Array<UserMessage | AssistantMessage> = []
  for (const msg of cleaned) {
    if (msg.type === 'assistant' && isWhitespaceOnlyAssistant(msg)) {
      continue
    }
    const prev = afterWhitespace[afterWhitespace.length - 1]
    if (msg.type === 'user' && prev?.type === 'user') {
      afterWhitespace[afterWhitespace.length - 1] = mergeUserMessages(prev, msg)
    } else {
      afterWhitespace.push(msg)
    }
  }
  cleaned = afterWhitespace

  // Post-pass 4: Ensure non-final assistants have non-empty content
  cleaned = cleaned.map((msg, idx) => {
    if (
      msg.type === 'assistant' &&
      idx < cleaned.length - 1 &&
      msg.message.content.length === 0
    ) {
      return {
        ...msg,
        message: {
          ...msg.message,
          content: [{ type: 'text', text: NO_CONTENT_MESSAGE, citations: [] }],
        },
      }
    }
    return msg
  })

  // Post-pass 5: Unconditionally sanitize error tool_result content
  cleaned = sanitizeErrorToolResultContent(cleaned)

  // Post-pass 6: Validate base64 image payload sizes
  validateImagesForApi(cleaned)

  return cleaned
}

/**
 * Guarantees strict 1:1 pairing between every assistant `tool_use` and the
 * immediately following user `tool_result` message:
 * - Strips orphaned leading/unpaired `tool_result` blocks.
 * - Deduplicates repeated `tool_use` IDs across the conversation.
 * - Inserts synthetic error `tool_result` blocks for any missing results.
 * - Throws in strict mode (`getStrictToolResultPairing()`) if repairs occurred.
 */
export function ensureToolResultPairing(
  messages: ReadonlyArray<UserMessage | AssistantMessage>,
): Array<UserMessage | AssistantMessage> {
  const result: Array<UserMessage | AssistantMessage> = []
  const allSeenToolUseIds = new Set<string>()
  let repaired = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.type === 'user') {
      const prev = result[result.length - 1]
      if (prev?.type !== 'assistant') {
        if (Array.isArray(msg.message.content)) {
          const nonToolResults = msg.message.content.filter(
            b => b.type !== 'tool_result',
          )
          if (nonToolResults.length !== msg.message.content.length) {
            repaired = true
            if (nonToolResults.length > 0) {
              result.push({
                ...msg,
                message: { role: 'user', content: nonToolResults },
              })
            } else if (result.length === 0) {
              result.push({
                ...msg,
                message: {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: '[Orphaned tool result removed due to conversation resume]',
                    },
                  ],
                },
              })
            }
            continue
          }
        }
      }
      result.push(msg)
      continue
    }

    // Assistant message: deduplicate tool_use IDs and drop unpaired server/mcp tool_use
    const pairedServerIds = new Set<string>()
    for (const block of msg.message.content) {
      const rec = block as { type?: string; tool_use_id?: string }
      if (
        rec.type &&
        rec.type.endsWith('_tool_result') &&
        typeof rec.tool_use_id === 'string'
      ) {
        pairedServerIds.add(rec.tool_use_id)
      }
    }

    const sanitizedAssistantContent: BetaContentBlock[] = []
    const expectedToolUseIds: string[] = []

    for (const block of msg.message.content) {
      if (block.type === 'tool_use') {
        if (allSeenToolUseIds.has(block.id)) {
          repaired = true
          continue
        }
        allSeenToolUseIds.add(block.id)
        expectedToolUseIds.push(block.id)
        sanitizedAssistantContent.push(block)
        continue
      }
      const rec = block as { type?: string; id?: string }
      if (
        (rec.type === 'server_tool_use' || rec.type === 'mcp_tool_use') &&
        typeof rec.id === 'string' &&
        !pairedServerIds.has(rec.id)
      ) {
        repaired = true
        continue
      }
      sanitizedAssistantContent.push(block)
    }

    const assistantMsg: AssistantMessage =
      sanitizedAssistantContent.length === msg.message.content.length
        ? msg
        : {
            ...msg,
            message: {
              ...msg.message,
              content:
                sanitizedAssistantContent.length > 0
                  ? sanitizedAssistantContent
                  : [
                      {
                        type: 'text',
                        text: '[Tool use interrupted]',
                        citations: [],
                      },
                    ],
            },
          }

    result.push(assistantMsg)

    const nextMsg = messages[i + 1]
    const expectedSet = new Set(expectedToolUseIds)

    if (nextMsg?.type === 'user') {
      const nextBlocks = toBlockArray(nextMsg.message.content)
      const seenResultIds = new Set<string>()
      const validBlocks: ContentBlockParam[] = []

      for (const block of nextBlocks) {
        if (block.type === 'tool_result') {
          if (!expectedSet.has(block.tool_use_id)) {
            repaired = true
            continue
          }
          if (seenResultIds.has(block.tool_use_id)) {
            repaired = true
            continue
          }
          seenResultIds.add(block.tool_use_id)
          validBlocks.push(block)
        } else {
          validBlocks.push(block)
        }
      }

      const syntheticMissing: ToolResultBlockParam[] = []
      for (const expectedId of expectedToolUseIds) {
        if (!seenResultIds.has(expectedId)) {
          repaired = true
          syntheticMissing.push({
            type: 'tool_result',
            tool_use_id: expectedId,
            content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
            is_error: true,
          })
        }
      }

      const combined = hoistToolResults([...syntheticMissing, ...validBlocks])
      if (combined.length === 0) {
        result.push(
          createUserMessage({
            content: NO_CONTENT_MESSAGE,
            isMeta: true,
          }),
        )
      } else {
        result.push({
          ...nextMsg,
          message: { role: 'user', content: combined },
        })
      }
      i++ // Consumed nextMsg
    } else if (expectedToolUseIds.length > 0) {
      repaired = true
      const syntheticMissing: ToolResultBlockParam[] = expectedToolUseIds.map(
        id => ({
          type: 'tool_result',
          tool_use_id: id,
          content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
          is_error: true,
        }),
      )
      result.push(
        createUserMessage({
          content: syntheticMissing,
          isMeta: true,
        }),
      )
    }
  }

  if (repaired && getStrictToolResultPairing()) {
    throw new Error(
      'Strict tool_use/tool_result pairing violation detected during message normalization.',
    )
  }

  return result
}
