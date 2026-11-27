/**
 * Complete 27-event lifecycle Hooks type contracts & JSON response Zod schemas.
 *
 * Preserves the exact published external stdin/stdout Hook JSON wire protocol
 * (`session_id`, `transcript_path`, `permission_mode`, `hook_event_name`,
 * `tool_name`, `tool_input`, `tool_use_id`, `hookSpecificOutput`,
 * `permissionDecision`, `updatedInput`, `additionalContext`, etc.).
 */

import { z } from 'zod/v4'
import type { AppState } from '../state/app_state_store.js'
import type { HookEvent } from './forward.js'
import type { Message } from './message.js'
import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from './permissions.js'
import { lazySchema } from '../utilities/lazy_schema.js'
import {
  permissionBehaviorSchema,
  permissionUpdateSchema,
} from '../utilities/permissions/permission_update_schema.js'

export type { HookEvent }

/**
 * All 27 supported lifecycle hook events.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const satisfies readonly HookEvent[]

const HOOK_EVENT_SET = new Set<string>(HOOK_EVENTS)

export function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENT_SET.has(value)
}

// ============================================================================
// Base & Event-Specific Hook Input Payloads (External Wire Contract)
// ============================================================================

export interface BaseHookInput {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: PermissionMode
  agent_id?: string
  agent_type?: string
}

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response: unknown
  tool_use_id: string
}

export interface PostToolUseFailureHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
  error: string
  is_interrupt?: boolean
}

export interface NotificationHookInput extends BaseHookInput {
  hook_event_name: 'Notification'
  message: string
  title?: string
  notification_type?: string
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: 'SessionStart'
  source: 'startup' | 'resume' | 'clear' | 'compact'
  model?: string
}

export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: 'SessionEnd'
  reason: string
}

export interface StopHookInput extends BaseHookInput {
  hook_event_name: 'Stop'
  stop_hook_active: boolean
  last_assistant_message?: string
}

export interface StopFailureHookInput extends BaseHookInput {
  hook_event_name: 'StopFailure'
  error: string
  error_details?: string
}

export interface SubagentStartHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStart'
  agent_id: string
  agent_type: string
}

export interface SubagentStopHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStop'
  stop_hook_active: boolean
  agent_id: string
  agent_type?: string
  agent_transcript_path?: string
  last_assistant_message?: string
}

export interface PreCompactHookInput extends BaseHookInput {
  hook_event_name: 'PreCompact'
  trigger: 'manual' | 'auto'
  custom_instructions: string | null
}

export interface PostCompactHookInput extends BaseHookInput {
  hook_event_name: 'PostCompact'
  trigger: 'manual' | 'auto'
  compact_summary: string
}

export interface PermissionRequestHookInput extends BaseHookInput {
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: Record<string, unknown>
  permission_suggestions?: PermissionUpdate[]
}

export interface PermissionDeniedHookInput extends BaseHookInput {
  hook_event_name: 'PermissionDenied'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
  reason: string
}

export interface SetupHookInput extends BaseHookInput {
  hook_event_name: 'Setup'
  trigger: 'init' | 'maintenance'
}

export interface TeammateIdleHookInput extends BaseHookInput {
  hook_event_name: 'TeammateIdle'
  teammate_name: string
  team_name: string
}

export interface TaskCreatedHookInput extends BaseHookInput {
  hook_event_name: 'TaskCreated'
  task_id: string
  task_subject: string
  task_description?: string
}

export interface TaskCompletedHookInput extends BaseHookInput {
  hook_event_name: 'TaskCompleted'
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export interface ElicitationHookInput extends BaseHookInput {
  hook_event_name: 'Elicitation'
  mcp_server_name: string
  message: string
  requested_schema?: Record<string, unknown>
}

export interface ElicitationResultHookInput extends BaseHookInput {
  hook_event_name: 'ElicitationResult'
  mcp_server_name: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export interface ConfigChangeHookInput extends BaseHookInput {
  hook_event_name: 'ConfigChange'
  source: string
  file_path?: string
}

export interface WorktreeCreateHookInput extends BaseHookInput {
  hook_event_name: 'WorktreeCreate'
  name: string
}

export interface WorktreeRemoveHookInput extends BaseHookInput {
  hook_event_name: 'WorktreeRemove'
  worktree_path: string
}

export interface InstructionsLoadedHookInput extends BaseHookInput {
  hook_event_name: 'InstructionsLoaded'
  file_path: string
  memory_type: string
  load_reason: string
}

export interface CwdChangedHookInput extends BaseHookInput {
  hook_event_name: 'CwdChanged'
  old_cwd: string
  new_cwd: string
}

export interface FileChangedHookInput extends BaseHookInput {
  hook_event_name: 'FileChanged'
  file_path: string
  event: 'change' | 'add' | 'unlink'
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | NotificationHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | StopFailureHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | PermissionRequestHookInput
  | PermissionDeniedHookInput
  | SetupHookInput
  | TeammateIdleHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | ConfigChangeHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | InstructionsLoadedHookInput
  | CwdChangedHookInput
  | FileChangedHookInput

// ============================================================================
// Interactive Prompt Elicitation Protocol for Command Hooks
// ============================================================================

export const promptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z.string(),
    message: z.string(),
    options: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
)

export type PromptRequest = z.infer<ReturnType<typeof promptRequestSchema>>

export interface PromptResponse {
  prompt_response: string
  selected: string
}

// ============================================================================
// Hook JSON Output Schemas
// ============================================================================

export const syncHookResponseSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional(),
    suppressOutput: z.boolean().optional(),
    stopReason: z.string().optional(),
    decision: z.enum(['approve', 'block']).optional(),
    reason: z.string().optional(),
    systemMessage: z.string().optional(),
    hookSpecificOutput: z
      .union([
        z.object({
          hookEventName: z.literal('PreToolUse'),
          permissionDecision: permissionBehaviorSchema().optional(),
          permissionDecisionReason: z.string().optional(),
          updatedInput: z.record(z.string(), z.unknown()).optional(),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('UserPromptSubmit'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('SessionStart'),
          additionalContext: z.string().optional(),
          initialUserMessage: z.string().optional(),
          watchPaths: z.array(z.string()).optional(),
        }),
        z.object({
          hookEventName: z.literal('Setup'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('SubagentStart'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PostToolUse'),
          additionalContext: z.string().optional(),
          updatedMCPToolOutput: z.unknown().optional(),
        }),
        z.object({
          hookEventName: z.literal('PostToolUseFailure'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PermissionDenied'),
          retry: z.boolean().optional(),
        }),
        z.object({
          hookEventName: z.literal('Notification'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PermissionRequest'),
          decision: z.union([
            z.object({
              behavior: z.literal('allow'),
              updatedInput: z.record(z.string(), z.unknown()).optional(),
              updatedPermissions: z.array(permissionUpdateSchema()).optional(),
            }),
            z.object({
              behavior: z.literal('deny'),
              message: z.string().optional(),
              interrupt: z.boolean().optional(),
            }),
          ]),
        }),
        z.object({
          hookEventName: z.literal('Elicitation'),
          action: z.enum(['accept', 'decline', 'cancel']).optional(),
          content: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({
          hookEventName: z.literal('ElicitationResult'),
          action: z.enum(['accept', 'decline', 'cancel']).optional(),
          content: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({
          hookEventName: z.literal('CwdChanged'),
          watchPaths: z.array(z.string()).optional(),
        }),
        z.object({
          hookEventName: z.literal('FileChanged'),
          watchPaths: z.array(z.string()).optional(),
        }),
        z.object({
          hookEventName: z.literal('WorktreeCreate'),
          worktreePath: z.string(),
        }),
      ])
      .optional(),
  }),
)

export const asyncHookResponseSchema = lazySchema(() =>
  z.object({
    async: z.literal(true),
    asyncTimeout: z.number().optional(),
  }),
)

export const hookJSONOutputSchema = lazySchema(() =>
  z.union([asyncHookResponseSchema(), syncHookResponseSchema()]),
)

export type SyncHookJSONOutput = z.infer<
  ReturnType<typeof syncHookResponseSchema>
>
export type AsyncHookJSONOutput = z.infer<
  ReturnType<typeof asyncHookResponseSchema>
>
export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput

export function isSyncHookJSONOutput(
  json: HookJSONOutput,
): json is SyncHookJSONOutput {
  return !('async' in json && json.async === true)
}

export function isAsyncHookJSONOutput(
  json: HookJSONOutput,
): json is AsyncHookJSONOutput {
  return 'async' in json && json.async === true
}

// ============================================================================
// Programmatic Callback & Function Hooks + Execution Results
// ============================================================================

export interface HookCallbackContext {
  getAppState: () => AppState
}

export interface HookCallback {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseId: string | null,
    abort: AbortSignal | undefined,
    hookIndex?: number,
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean
  if?: string
  once?: boolean
}

export interface HookFunction {
  type: 'function'
  id?: string
  callback: (
    messages: readonly Message[],
    input?: HookInput,
  ) => boolean | Promise<boolean>
  errorMessage: string
  timeout?: number
  if?: string
  once?: boolean
}

export interface HookCallbackMatcher {
  matcher?: string
  hooks: HookCallback[]
  pluginName?: string
}

export interface HookProgress {
  type: 'hook_progress'
  hookEvent: HookEvent
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}

export interface HookBlockingError {
  blockingError: string
  command: string
}

export type PermissionRequestResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
    }

export interface HookResult {
  message?: Message
  systemMessage?: Message
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
  watchPaths?: string[]
  worktreePath?: string
}

export interface AggregatedHookResult {
  messages: Message[]
  blockingErrors: HookBlockingError[]
  preventContinuation: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
  watchPaths: string[]
  worktreePath?: string
}
