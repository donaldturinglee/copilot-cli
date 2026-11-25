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
