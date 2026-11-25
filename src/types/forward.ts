/**
 * Forward-compatible pure type contracts for downstream Phase 1–12 modules
 * referenced via `import type` by Phase 0 type files (logs, command, plugin,
 * textInputTypes). Keeping these contracts in Phase 0 preserves strict
 * zero backward-dependency ordering while ensuring full `tsc --noEmit` safety.
 * Subsequent phases either implement these exact shapes or re-export them.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type {
  AttachmentMessage,
  HookResultMessage,
  Message,
  SystemMessage,
  UserMessage,
} from './message.js'
import type { PermissionResult } from './permissions.js'
import type { ToolProgressData } from './tools.js'

// From Phase 10: src/entrypoints/agentSdkTypes.ts -> coreTypes.generated.ts
export type SdkAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

// From Phase 3: src/tools/shared/gitOperationTracking.ts
export type CommitKind = 'committed' | 'amended' | 'cherry-picked'
export type BranchAction = 'merged' | 'rebased'
export type PrAction =
  | 'created'
  | 'edited'
  | 'merged'
  | 'commented'
  | 'closed'
  | 'ready'

// From Phase 4: src/types/hooks.ts
export type HookProgress = {
  type: 'hook_progress'
  hookEvent: string
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}

// From Phase 3: src/Tool.ts
export type Progress = ToolProgressData | HookProgress | Record<string, unknown>

// From Phase 7: src/utils/attachments.ts
export type Attachment = {
  type: string
  [key: string]: unknown
}

// From Phase 7: src/utils/fileHistory.ts
export type FileHistoryBackup = {
  backupFileName: string | null
  version: number
  backupTime: Date
}

export type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}

// From Phase 3: src/utils/toolResultStorage.ts
export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

// From Phase 1: src/utils/settings/constants.ts
export type SettingSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'

// From Phase 2: src/utils/effort.ts
export type EffortLevel = 'low' | 'medium' | 'high' | 'max'
export type EffortValue = EffortLevel | number

// From Phase 5: src/utils/theme.ts
export type ThemeName =
  | 'dark'
  | 'light'
  | 'light-daltonized'
  | 'dark-daltonized'
  | 'light-ansi'
  | 'dark-ansi'

// From Phase 3: src/utils/imageResizer.ts
export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

// From Phase 1: src/utils/config.ts
export type PastedContent = {
  id: number
  type: 'text' | 'image'
  content: string
  mediaType?: string
  filename?: string
  dimensions?: ImageDimensions
  sourcePath?: string
}

// From Phase 5: src/utils/textHighlighting.ts
export type TextHighlight = {
  start: number
  end: number
  color: string | undefined
  dimColor?: boolean
  inverse?: boolean
  shimmerColor?: string
  priority: number
}

// From Phase 5: src/ink/events/input-event.ts
export type Key = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageDown: boolean
  pageUp: boolean
  wheelUp: boolean
  wheelDown: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  fn: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
  super: boolean
}

// From Phase 12: src/utils/ide.ts
export type IdeType =
  | 'cursor'
  | 'windsurf'
  | 'vscode'
  | 'pycharm'
  | 'intellij'
  | 'webstorm'
  | 'phpstorm'
  | 'rubymine'
  | 'clion'
  | 'goland'
  | 'rider'
  | 'datagrip'
  | 'appcode'
  | 'dataspell'
  | 'aqua'
  | 'gateway'
  | 'fleet'
  | 'androidstudio'

export type IdeExtensionInstallationStatus = {
  installed: boolean
  error: string | null
  installedVersion: string | null
  ideType: IdeType | null
}

// From Phase 4: src/schemas/hooks.ts & src/utils/settings/types.ts
export type HooksSettings = Record<string, unknown[]>

// From Phase 8: src/services/mcp/types.ts
export type ConfigScope =
  | 'local'
  | 'user'
  | 'project'
  | 'dynamic'
  | 'enterprise'
  | 'claudeai'
  | 'managed'

export type McpServerConfig =
  | {
      type?: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  | {
      type: 'sse' | 'http'
      url: string
      headers?: Record<string, string>
      headersHelper?: string
      oauth?: {
        clientId?: string
        callbackPort?: number
        authServerMetadataUrl?: string
        xaa?: boolean
      }
    }
  | {
      type: 'sse-ide'
      url: string
      ideName: string
      ideRunningInWindows?: boolean
    }
  | {
      type: 'ws-ide'
      url: string
      ideName: string
      authToken?: string
      ideRunningInWindows?: boolean
    }
  | {
      type: 'ws'
      url: string
      headers?: Record<string, string>
      headersHelper?: string
    }
  | {
      type: 'sdk'
      name: string
    }
  | {
      type: 'claudeai-proxy'
      url: string
      id: string
    }

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  pluginSource?: string
}

// From Phase 8: src/services/lsp/types.ts
export type LspServerConfig = {
  command: string
  args?: string[]
  extensionToLanguage: Record<string, string>
  transport?: 'stdio' | 'socket'
  env?: Record<string, string>
  initializationOptions?: unknown
  settings?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  shutdownTimeout?: number
  restartOnCrash?: boolean
  maxRestarts?: number
}

// From Phase 8: src/utils/plugins/schemas.ts
export type PluginAuthor = {
  name: string
  email?: string
  url?: string
}

export type CommandMetadata = {
  source?: string
  content?: string
  description?: string
  argumentHint?: string
  model?: string
  allowedTools?: string[]
}

export type PluginManifest = {
  name: string
  version?: string
  description?: string
  author?: PluginAuthor
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  dependencies?: unknown[]
  hooks?: string | HooksSettings | Array<string | HooksSettings>
  commands?: string | string[] | Record<string, CommandMetadata>
  agents?: string | string[]
  skills?: string | string[]
  outputStyles?: string | string[]
  channels?: unknown[]
  mcpServers?:
    | string
    | Record<string, McpServerConfig>
    | Array<string | Record<string, McpServerConfig>>
  lspServers?:
    | string
    | Record<string, LspServerConfig>
    | Array<string | Record<string, LspServerConfig>>
  settings?: Record<string, unknown>
  userConfig?: Record<string, unknown>
}

// From Phase 8: src/skills/bundledSkills.ts
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

// From Phase 7: src/services/compact/compact.ts
export interface CompactionResult {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  messagesToKeep?: Message[]
  userDisplayMessage?: string
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
  compactionUsage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  }
}

// From Phase 3: src/Tool.ts (forward-compatible shell extended in Phase 3)
export type ToolUseContext = {
  abortController: AbortController
  messages: Message[]
  [key: string]: unknown
}

// From Phase 9: src/Task.ts
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

// From Phase 4: src/hooks/useCanUseTool.ts
export type CanUseToolFn = (
  tool: unknown,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  assistantMessage: unknown,
  toolUseId: string,
) => Promise<PermissionResult>

// From Phase 1/2: Model usage & model selection contracts
export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUsd: number
  contextWindow: number
  maxOutputTokens: number
}

export type ModelSetting = string | null

export type ModelStrings = {
  haiku35?: string
  haiku45?: string
  sonnet35?: string
  sonnet37?: string
  sonnet40?: string
  sonnet45?: string
  sonnet46?: string
  opus40?: string
  opus41?: string
  opus45?: string
  opus46?: string
  [key: string]: string | undefined
}

export type AgentColorName =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan'

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'

export type HookCallbackMatcher = {
  matcher?: string
  hooks: Array<(...args: unknown[]) => Promise<unknown>>
  timeout?: number
}

export type PluginHookMatcher = {
  matcher?: string
  hooks: unknown[]
  pluginRoot: string
  pluginName?: string
  pluginId?: string
}

// Lightweight structural OpenTelemetry contracts (avoids pulling @opentelemetry/* in Phase 1)
export type OtelAttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>

export type OtelAttributes = Record<string, OtelAttributeValue | undefined>

export type OtelMetricOptions = {
  description?: string
  unit?: string
}

export type OtelCounter = {
  add(value: number, attributes?: OtelAttributes): void
}

export type OtelMeter = {
  createCounter(name: string, options?: OtelMetricOptions): OtelCounter
}

export type OtelLogRecord = {
  body?: string
  attributes?: OtelAttributes
  severityText?: string
  severityNumber?: number
}

export type OtelEventLogger = {
  emit(logRecord: OtelLogRecord): void
}

export type OtelLoggerProvider = {
  forceFlush?: () => Promise<void>
  shutdown?: () => Promise<void>
}

export type OtelMeterProvider = {
  forceFlush?: () => Promise<void>
  shutdown?: () => Promise<void>
}

export type OtelTracerProvider = {
  forceFlush?: () => Promise<void>
  shutdown?: () => Promise<void>
}

export type GitHubActionsMetadata = {
  actorId?: string
  repositoryId?: string
  repositoryOwnerId?: string
}

export type CoreUserData = {
  deviceId: string
  sessionId: string
  platform: 'win32' | 'darwin' | 'linux'
  organizationUuid?: string
  accountUuid?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  githubActionsMetadata?: GitHubActionsMetadata
}

// From Phase 1.2 / Phase 9: Task & UI forward-compatible structural types
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export type BaseTaskState = {
  id: string
  type: TaskType
  status: TaskStatus
  description?: string
  abortController?: AbortController
  [key: string]: unknown
}

export type InProcessTeammateTaskState = BaseTaskState & {
  type: 'in_process_teammate'
  identity?: {
    agentId: string
    agentName: string
    teamName: string
    color?: string
  }
}

export type LocalAgentTaskState = BaseTaskState & {
  type: 'local_agent'
  retain?: boolean
  messages?: Message[]
  diskLoaded?: boolean
  evictAfter?: number
}

export type OtherTaskState = Omit<BaseTaskState, 'type'> & {
  type: Exclude<TaskType, 'in_process_teammate' | 'local_agent'>
}

export type TaskState =
  | InProcessTeammateTaskState
  | LocalAgentTaskState
  | OtherTaskState

export type TodoItem = {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export type TodoList = TodoItem[]

export type Notification = {
  key: string
  text: string
  priority?: 'low' | 'medium' | 'high' | 'immediate'
  color?: string
  timeoutMs?: number
  invalidates?: string[]
  [key: string]: unknown
}

export type ElicitationRequestEvent = {
  serverName: string
  requestId?: string
  message?: string
  requestedSchema?: Record<string, unknown>
  resolve?: (response: unknown) => void
  [key: string]: unknown
}

export type McpServerConnection = {
  name: string
  type: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  config?: McpServerConfig
  [key: string]: unknown
}

export type ServerResource = {
  uri: string
  name: string
  description?: string
  mimeType?: string
  [key: string]: unknown
}

export type Tool = {
  name: string
  [key: string]: unknown
}

export type AttributionState = {
  fileStates: Map<string, unknown>
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
  [key: string]: unknown
}

export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
  lastDenialTime?: number
}

export type AllowedPrompt = {
  tool: string
  prompt: string
}

export type ReplHookContext = Record<string, unknown>

export type ThemeSetting = ThemeName | 'auto'

export type BillingType = string

export type ReferralEligibilityResponse = {
  eligible: boolean
  remainingPasses?: number
  [key: string]: unknown
}

export type StoredCompanion = {
  name?: string
  species?: string
  [key: string]: unknown
}

export type ModelOption = {
  value: string
  label: string
  description?: string
}

export type MemoryType =
  | 'User'
  | 'Local'
  | 'Project'
  | 'Managed'
  | 'AutoMem'
  | 'TeamMem'
