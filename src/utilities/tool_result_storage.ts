/**
 * Oversized tool-result disk persistence (`<persisted-output>` + 2KB preview)
 * and frozen per-message budget enforcement (`ContentReplacementState`).
 *
 * Prompt Cache Invariants:
 * 1. Once a `tool_use_id` is observed by `enforceToolResultBudget()`, its
 *    keep-vs-replace decision is permanently frozen in `seenIds`/`replacements`
 *    so subsequent turns never mutate earlier cached history.
 * 2. Tools with `maxResultSizeChars: Infinity` (e.g. `Read`) opt out of disk
 *    spilling because they apply their own line/byte pagination.
 * 3. Disk persistence uses symlink-safe exclusive creation (`O_NOFOLLOW | O_EXCL`
 *    on POSIX, `O_EXCL` on Windows) with `0o700` dir / `0o600` file modes.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  writeSync,
} from 'fs'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
} from '../constants/tool_limits.js'
import type { AnyTool, ContentReplacementStateView, ToolUseContext } from '../tool.js'
import type { ContentReplacementRecord } from '../types/forward.js'
import type { Message, UserMessage } from '../types/message.js'
import { getClaudeConfigHomeDir } from './env_utils.js'
import { getErrnoCode } from './errors.js'
import { sanitizePath } from './path.js'
import { getPlatform } from './platform.js'

export const PREVIEW_SIZE_BYTES = 2_000
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'

export interface ContentReplacementState extends ContentReplacementStateView {
  seenIds: Set<string>
  replacements: Map<string, string>
  records: ContentReplacementRecord[]
}

export function createContentReplacementState(): ContentReplacementState {
  return {
    seenIds: new Set<string>(),
    replacements: new Map<string, string>(),
    records: [],
  }
}

export function cloneContentReplacementState(
  state: ContentReplacementStateView,
): ContentReplacementState {
  return {
    seenIds: new Set(state.seenIds),
    replacements: new Map(state.replacements),
    records: state.records ? state.records.map(r => ({ ...r })) : [],
  }
}

export function provisionContentReplacementState(
  context: ToolUseContext,
): ContentReplacementState {
  if (context.contentReplacementState) {
    const existing = context.contentReplacementState
    if (!existing.records) {
      existing.records = []
    }
    return existing as ContentReplacementState
  }
  const fresh = createContentReplacementState()
  context.contentReplacementState = fresh
  return fresh
}

export function getPersistenceThreshold(
  toolMaxResultSizeChars?: number,
): number {
  if (toolMaxResultSizeChars === Infinity) {
    return Infinity
  }
  const requested = toolMaxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS
  return Math.min(requested, MAX_TOOL_RESULT_BYTES)
}

export function getPerMessageBudgetLimit(): number {
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

export function getToolResultsDir(): string {
  const projectKey = sanitizePath(getOriginalCwd() || 'default')
  return join(
    getClaudeConfigHomeDir(),
    'projects',
    projectKey,
    getSessionId(),
    'tool-results',
  )
}

export function getToolResultPath(toolUseId: string, isJson = false): string {
  const safeId = toolUseId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool_result'
  const ext = isJson ? 'json' : 'txt'
  return join(getToolResultsDir(), `${safeId}.${ext}`)
}

export function ensureToolResultsDir(): string {
  const dir = getToolResultsDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Generates a newline-aligned preview bounded by `maxBytes` (default 2,000 bytes).
 */
export function generatePreview(
  content: string,
  maxBytes: number = PREVIEW_SIZE_BYTES,
): { preview: string; hasMore: boolean } {
  const totalBytes = Buffer.byteLength(content, 'utf8')
  if (totalBytes <= maxBytes) {
    return { preview: content, hasMore: false }
  }

  let end = Math.min(content.length, maxBytes)
  while (end > 0 && Buffer.byteLength(content.slice(0, end), 'utf8') > maxBytes) {
    end -= Math.max(1, Math.floor((Buffer.byteLength(content.slice(0, end), 'utf8') - maxBytes) / 2))
  }

  const candidate = content.slice(0, end)
  const lastNewline = candidate.lastIndexOf('\n')
  const aligned =
    lastNewline >= Math.floor(candidate.length * 0.5)
      ? candidate.slice(0, lastNewline)
      : candidate

  return {
    preview: aligned,
    hasMore: aligned.length < content.length,
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

/**
 * Builds the model-facing `<persisted-output>` stub pointing to the disk file
 * with a 2KB preview.
 */
export function buildLargeToolResultMessage(params: {
  filepath: string
  originalSize: number
  isJson?: boolean
  preview: string
  hasMore: boolean
}): string {
  const previewBlock = params.hasMore
    ? `${params.preview}\n...`
    : params.preview
  return [
    PERSISTED_OUTPUT_TAG,
    `Output too large (${formatSize(params.originalSize)}). Full output saved to: ${params.filepath}`,
    'Use the Read tool with offset/limit or Grep to inspect specific sections of this file.',
    '',
    `Preview (first ${formatSize(Buffer.byteLength(params.preview, 'utf8'))}):`,
    previewBlock,
    '</persisted-output>',
  ].join('\n')
}

/**
 * Atomically persists oversized tool output to disk using symlink-safe flags
 * (`O_NOFOLLOW | O_EXCL` on POSIX, `O_EXCL` on Windows) with mode `0o600`.
 */
export function persistToolResult(
  content: string,
  toolUseId: string,
  isJson = false,
): { filepath: string; originalSize: number } {
  ensureToolResultsDir()
  const filepath = getToolResultPath(toolUseId, isJson)
  const originalSize = Buffer.byteLength(content, 'utf8')

  const flags =
    getPlatform() === 'windows'
      ? fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      : fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0)

  let fd: number | undefined
  try {
    fd = openSync(filepath, flags, 0o600)
    writeSync(fd, content, 0, 'utf8')
  } catch (error) {
    // Content-addressed by unique toolUseId: if already persisted, reuse path
    if (getErrnoCode(error) !== 'EEXIST') {
      throw error
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }

  return { filepath, originalSize }
}

export function isToolResultContentEmpty(
  content: ToolResultBlockParam['content'],
): boolean {
  if (content === undefined) return true
  if (typeof content === 'string') return content.length === 0
  return content.length === 0
}

function extractSpillableText(
  content: ToolResultBlockParam['content'],
): { text: string; isJson: boolean; hasMedia: boolean } | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    const isJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    return { text: content, isJson, hasMedia: false }
  }
  if (!Array.isArray(content)) {
    return null
  }
  let hasMedia = false
  const textParts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'image' || (block as { type: string }).type === 'document') {
      hasMedia = true
    }
  }
  if (hasMedia || textParts.length === 0) {
    return null
  }
  const combined = textParts.join('\n')
  const trimmed = combined.trim()
  const isJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  return { text: combined, isJson, hasMedia }
}

/**
 * Checks a single `tool_result` block against its persistence threshold and
 * spills oversized text outputs to disk, replacing inline content with a
 * `<persisted-output>` preview stub.
 */
export function processToolResultBlock(
  block: ToolResultBlockParam,
  toolMaxResultSizeChars?: number,
): ToolResultBlockParam {
  const threshold = getPersistenceThreshold(toolMaxResultSizeChars)
  if (!Number.isFinite(threshold) || block.is_error === true) {
    return block
  }

  const extracted = extractSpillableText(block.content)
  if (!extracted || extracted.text.includes(PERSISTED_OUTPUT_TAG)) {
    return block
  }

  if (extracted.text.length <= threshold) {
    return block
  }

  const { filepath, originalSize } = persistToolResult(
    extracted.text,
    block.tool_use_id,
    extracted.isJson,
  )
  const { preview, hasMore } = generatePreview(extracted.text, PREVIEW_SIZE_BYTES)
  const stub = buildLargeToolResultMessage({
    filepath,
    originalSize,
    isJson: extracted.isJson,
    preview,
    hasMore,
  })

  return {
    ...block,
    content: stub,
  }
}

/**
 * Applies per-tool persistence thresholds using `tool.maxResultSizeChars`.
 */
export function processPreMappedToolResultBlock(
  block: ToolResultBlockParam,
  tool?: Pick<AnyTool, 'maxResultSizeChars'>,
): ToolResultBlockParam {
  return processToolResultBlock(block, tool?.maxResultSizeChars)
}

function getToolResultCharSize(block: ToolResultBlockParam): number {
  if (typeof block.content === 'string') {
    return block.content.length
  }
  if (!Array.isArray(block.content)) {
    return 0
  }
  let size = 0
  for (const item of block.content) {
    if (item.type === 'text') {
      size += item.text.length
    }
  }
  return size
}

function buildToolUseNameMap(messages: readonly Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') {
        map.set(block.id, block.name)
      }
    }
  }
  return map
}

function isToolResultUserMsg(msg: Message): msg is UserMessage {
  if (msg.type !== 'user' || !Array.isArray(msg.message.content)) {
    return false
  }
  return msg.message.content.some(b => b.type === 'tool_result')
}

/**
 * Enforces the aggregate per-message tool-result character budget (default
 * `200,000` chars) across consecutive user `tool_result` groups while freezing
 * keep/replace decisions in `state` so prompt cache prefixes never drift.
 */
export function enforceToolResultBudget(
  messages: readonly Message[],
  state: ContentReplacementState,
  perMessageBudget: number = getPerMessageBudgetLimit(),
  skipToolNames?: ReadonlySet<string>,
): { messages: Message[]; replacedIds: string[] } {
  const toolNameById = buildToolUseNameMap(messages)
  const replacedIds: string[] = []

  // Group indices of consecutive tool_result user messages (merged into one API user turn)
  const groups: number[][] = []
  let currentGroup: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (isToolResultUserMsg(msg)) {
      currentGroup.push(i)
    } else if (
      msg.type === 'progress' ||
      msg.type === 'attachment'
    ) {
      // Non-conversational messages between parallel tool results don't split a user turn
      continue
    } else {
      if (currentGroup.length > 0) {
        groups.push(currentGroup)
        currentGroup = []
      }
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  // Decide replacements per group (only for tool_use_ids not yet frozen in state.seenIds)
  for (const groupIndices of groups) {
    interface Candidate {
      toolUseId: string
      size: number
      text: string
      isJson: boolean
    }

    let groupTotal = 0
    const newCandidates: Candidate[] = []
    const newlySeenInGroup: string[] = []

    for (const msgIdx of groupIndices) {
      const msg = messages[msgIdx] as UserMessage
      if (!Array.isArray(msg.message.content)) continue
      for (const block of msg.message.content) {
        if (block.type !== 'tool_result') continue
        const id = block.tool_use_id
        const frozenReplacement = state.replacements.get(id)
        if (frozenReplacement !== undefined) {
          groupTotal += frozenReplacement.length
          continue
        }

        const size = getToolResultCharSize(block)
        groupTotal += size

        if (state.seenIds.has(id)) {
          // Previously frozen as kept inline: NEVER retroactively replace!
          continue
        }

        newlySeenInGroup.push(id)
        const toolName = toolNameById.get(id)
        if (toolName && skipToolNames?.has(toolName)) {
          continue
        }
        if (block.is_error === true) {
          continue
        }
        const extracted = extractSpillableText(block.content)
        if (!extracted || extracted.text.includes(PERSISTED_OUTPUT_TAG)) {
          continue
        }
        newCandidates.push({
          toolUseId: id,
          size,
          text: extracted.text,
          isJson: extracted.isJson,
        })
      }
    }

    if (groupTotal > perMessageBudget && newCandidates.length > 0) {
      // Spill largest candidates first until group fits under perMessageBudget
      newCandidates.sort((a, b) => b.size - a.size)
      for (const candidate of newCandidates) {
        if (groupTotal <= perMessageBudget) {
          break
        }
        const { filepath, originalSize } = persistToolResult(
          candidate.text,
          candidate.toolUseId,
          candidate.isJson,
        )
        const { preview, hasMore } = generatePreview(
          candidate.text,
          PREVIEW_SIZE_BYTES,
        )
        const replacement = buildLargeToolResultMessage({
          filepath,
          originalSize,
          isJson: candidate.isJson,
          preview,
          hasMore,
        })
        state.replacements.set(candidate.toolUseId, replacement)
        state.records.push({
          kind: 'tool-result',
          toolUseId: candidate.toolUseId,
          replacement,
        })
        replacedIds.push(candidate.toolUseId)
        groupTotal = groupTotal - candidate.size + replacement.length
      }
    }

    for (const id of newlySeenInGroup) {
      state.seenIds.add(id)
    }
  }

  if (state.replacements.size === 0) {
    return { messages: [...messages], replacedIds }
  }

  // Apply frozen replacements non-destructively
  const output = messages.map(msg => {
    if (!isToolResultUserMsg(msg) || !Array.isArray(msg.message.content)) {
      return msg
    }
    let changed = false
    const nextContent = msg.message.content.map(block => {
      if (block.type !== 'tool_result') return block
      const replacement = state.replacements.get(block.tool_use_id)
      if (replacement === undefined) return block
      if (block.content === replacement) return block
      changed = true
      return {
        ...block,
        content: replacement,
      }
    })
    return changed
      ? {
          ...msg,
          message: {
            ...msg.message,
            content: nextContent,
          },
        }
      : msg
  })

  return { messages: output, replacedIds }
}

/**
 * Convenience async wrapper applying `enforceToolResultBudget` with optional
 * tool list to auto-detect `maxResultSizeChars: Infinity` opt-outs.
 */
export async function applyToolResultBudget(
  messages: readonly Message[],
  state: ContentReplacementState,
  tools?: readonly Pick<AnyTool, 'name' | 'maxResultSizeChars'>[],
  perMessageBudget?: number,
): Promise<{ messages: Message[]; replacedIds: string[] }> {
  const skipToolNames = new Set<string>()
  if (tools) {
    for (const tool of tools) {
      if (tool.maxResultSizeChars === Infinity) {
        skipToolNames.add(tool.name)
      }
    }
  }
  return enforceToolResultBudget(
    messages,
    state,
    perMessageBudget ?? getPerMessageBudgetLimit(),
    skipToolNames,
  )
}

/**
 * Reconstructs a `ContentReplacementState` from persisted JSONL replacement
 * records on session resume.
 */
export function reconstructContentReplacementState(
  records: readonly ContentReplacementRecord[],
  existingToolUseIds?: Iterable<string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  if (existingToolUseIds) {
    for (const id of existingToolUseIds) {
      state.seenIds.add(id)
    }
  }
  for (const record of records) {
    if (record.kind === 'tool-result') {
      state.seenIds.add(record.toolUseId)
      state.replacements.set(record.toolUseId, record.replacement)
      state.records.push({ ...record })
    }
  }
  return state
}

/**
 * Reconstructs `ContentReplacementState` for a resumed subagent transcript,
 * marking all historical `tool_result` IDs as frozen.
 */
export function reconstructForSubagentResume(
  messages: readonly Message[],
  records: readonly ContentReplacementRecord[] = [],
): ContentReplacementState {
  const seen = new Set<string>()
  for (const msg of messages) {
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          seen.add(block.tool_use_id)
        }
      }
    }
  }
  return reconstructContentReplacementState(records, seen)
}
