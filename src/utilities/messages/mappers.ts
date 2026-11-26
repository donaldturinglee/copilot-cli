/**
 * Wire-format mappers between internal `Message` objects and external Agent SDK
 * `SdkMessage` contracts.
 */

import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { NonNullableUsage } from '../../services/api/empty_usage.js'
import type { ClaudeAiLimits } from '../../services/claude_ai_limits.js'
import type { SdkAssistantMessageError } from '../../types/forward.js'
import type {
  CompactMetadata,
  Message,
  SystemLocalCommandMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { ApiKeySource } from '../auth.js'
import { randomUUID } from '../crypto.js'
import type { FastModeState } from '../fast_mode.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'

export interface SdkModelUsageWire {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}

export interface SdkPermissionDenial {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

export interface SdkSystemInitMessage {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: Array<{ name: string; status: string }>
  model: string
  permissionMode: PermissionMode
  slash_commands: string[]
  apiKeySource: ApiKeySource
  betas?: string[]
  claude_code_version: string
  output_style: string
  agents?: string[]
  skills: string[]
  plugins: Array<{ name: string; path: string; source?: string }>
  fast_mode_state?: FastModeState
  uuid: UUID
}

export interface SdkCompactMetadataWire {
  trigger: 'manual' | 'auto'
  pre_tokens: number
  preserved_segment?: {
    head_uuid: UUID
    anchor_uuid: UUID
    tail_uuid: UUID
  }
}

export interface SdkSystemCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  compact_metadata: SdkCompactMetadataWire
  uuid: UUID
  session_id: string
}

export interface SdkSystemApiRetryMessage {
  type: 'system'
  subtype: 'api_retry'
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: SdkAssistantMessageError
  uuid: UUID
  session_id: string
}

export interface SdkAssistantMessage {
  type: 'assistant'
  message: BetaMessage
  parent_tool_use_id: string | null
  error?: SdkAssistantMessageError
  uuid: UUID
  session_id: string
}

export interface SdkUserMessage {
  type: 'user'
  message: MessageParam
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  timestamp?: string
  isReplay?: true
  uuid?: UUID
  session_id?: string
}

export interface SdkStreamEventMessage {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  parent_tool_use_id: null
  uuid: UUID
  session_id: string
}

export interface SdkToolUseSummaryMessage {
  type: 'tool_use_summary'
  summary: string
  preceding_tool_use_ids: string[]
  uuid: UUID
  session_id: string
}

export interface SdkToolProgressMessage {
  type: 'tool_progress'
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  task_id?: string
  uuid: UUID
  session_id: string
}

interface SdkResultBase {
  type: 'result'
  is_error: boolean
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  stop_reason: string | null
  session_id: string
  total_cost_usd: number
  usage: NonNullableUsage
  modelUsage: Record<string, SdkModelUsageWire>
  permission_denials: SdkPermissionDenial[]
  fast_mode_state?: FastModeState
  uuid: UUID
}

export interface SdkResultSuccessMessage extends SdkResultBase {
  subtype: 'success'
  result: string
  structured_output?: unknown
}

export interface SdkResultErrorMessage extends SdkResultBase {
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
  errors: string[]
}

export type SdkResultMessage = SdkResultSuccessMessage | SdkResultErrorMessage

export type SdkMessage =
  | SdkSystemInitMessage
  | SdkSystemCompactBoundaryMessage
  | SdkSystemApiRetryMessage
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkStreamEventMessage
  | SdkToolUseSummaryMessage
  | SdkToolProgressMessage
  | SdkResultMessage

export interface SdkRateLimitInfo {
  status: ClaudeAiLimits['status']
  resetsAt?: number
  rateLimitType?: ClaudeAiLimits['rateLimitType']
  utilization?: number
  overageStatus?: ClaudeAiLimits['overageStatus']
  overageResetsAt?: number
  overageDisabledReason?: ClaudeAiLimits['overageDisabledReason']
  isUsingOverage?: boolean
}

/**
 * Converts internal `CompactMetadata` to snake_case wire format.
 */
export function toSdkCompactMetadata(
  meta: CompactMetadata,
): SdkCompactMetadataWire {
  return {
    trigger: meta.trigger,
    pre_tokens: meta.preTokens,
    ...(meta.preservedSegment
      ? {
          preserved_segment: {
            head_uuid: meta.preservedSegment.headUuid,
            anchor_uuid: meta.preservedSegment.anchorUuid,
            tail_uuid: meta.preservedSegment.tailUuid,
          },
        }
      : {}),
  }
}

/**
 * Converts wire-format `SdkCompactMetadataWire` back to internal `CompactMetadata`.
 */
export function fromSdkCompactMetadata(
  wire: SdkCompactMetadataWire,
): CompactMetadata {
  return {
    trigger: wire.trigger,
    preTokens: wire.pre_tokens,
    ...(wire.preserved_segment
      ? {
          preservedSegment: {
            headUuid: wire.preserved_segment.head_uuid,
            anchorUuid: wire.preserved_segment.anchor_uuid,
            tailUuid: wire.preserved_segment.tail_uuid,
          },
        }
      : {}),
  }
}

/**
 * Maps `ClaudeAiLimits` to external SDK rate-limit info.
 */
export function toSdkRateLimitInfo(limits: ClaudeAiLimits): SdkRateLimitInfo {
  return {
    status: limits.status,
    ...(limits.resetsAt !== undefined ? { resetsAt: limits.resetsAt } : {}),
    ...(limits.rateLimitType ? { rateLimitType: limits.rateLimitType } : {}),
    ...(limits.utilization !== undefined
      ? { utilization: limits.utilization }
      : {}),
    ...(limits.overageStatus ? { overageStatus: limits.overageStatus } : {}),
    ...(limits.overageResetsAt !== undefined
      ? { overageResetsAt: limits.overageResetsAt }
      : {}),
    ...(limits.overageDisabledReason
      ? { overageDisabledReason: limits.overageDisabledReason }
      : {}),
    ...(limits.isUsingOverage !== undefined
      ? { isUsingOverage: limits.isUsingOverage }
      : {}),
  }
}

/**
 * Converts a local command output system message into an SDK assistant message.
 */
export function localCommandOutputToSdkAssistantMessage(
  msg: SystemLocalCommandMessage,
): SdkAssistantMessage {
  const synthetic = createAssistantMessage({ content: msg.content })
  return {
    type: 'assistant',
    message: synthetic.message,
    parent_tool_use_id: null,
    uuid: msg.uuid,
    session_id: getSessionId(),
  }
}

/**
 * Converts external SDK user/assistant messages into internal `Message` objects.
 */
export function toInternalMessages(sdkMessages: readonly SdkMessage[]): Message[] {
  const results: Message[] = []
  for (const sdkMsg of sdkMessages) {
    if (sdkMsg.type === 'user') {
      results.push(
        createUserMessage({
          content: sdkMsg.message.content,
          uuid: sdkMsg.uuid ?? randomUUID(),
          timestamp: sdkMsg.timestamp,
          ...(sdkMsg.isSynthetic ? { isMeta: true } : {}),
          ...(sdkMsg.tool_use_result !== undefined
            ? { toolUseResult: sdkMsg.tool_use_result }
            : {}),
        }),
      )
    } else if (sdkMsg.type === 'assistant') {
      results.push({
        type: 'assistant',
        message: sdkMsg.message,
        requestId: undefined,
        uuid: sdkMsg.uuid,
        timestamp: new Date().toISOString(),
        ...(sdkMsg.error ? { error: sdkMsg.error } : {}),
      })
    }
  }
  return results
}

/**
 * Converts internal `Message` objects to external `SdkMessage` wire payloads.
 */
export function toSdkMessages(messages: readonly Message[]): SdkMessage[] {
  const sessionId = getSessionId()
  const results: SdkMessage[] = []
  for (const msg of messages) {
    if (msg.type === 'user') {
      results.push({
        type: 'user',
        message: msg.message,
        parent_tool_use_id: null,
        uuid: msg.uuid,
        session_id: sessionId,
        timestamp: msg.timestamp,
        ...(msg.isMeta || msg.isVisibleInTranscriptOnly
          ? { isSynthetic: true }
          : {}),
        ...(msg.toolUseResult !== undefined
          ? { tool_use_result: msg.toolUseResult }
          : {}),
      })
    } else if (msg.type === 'assistant') {
      results.push({
        type: 'assistant',
        message: msg.message,
        parent_tool_use_id: null,
        uuid: msg.uuid,
        session_id: sessionId,
        ...(msg.error ? { error: msg.error } : {}),
      })
    } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      results.push({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: toSdkCompactMetadata(msg.compactMetadata),
        uuid: msg.uuid,
        session_id: sessionId,
      })
    }
  }
  return results
}
