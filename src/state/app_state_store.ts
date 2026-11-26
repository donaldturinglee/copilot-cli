import type { Command } from '../types/command.js'
import type {
  AllowedPrompt,
  AttributionState,
  DenialTrackingState,
  EffortValue,
  ElicitationRequestEvent,
  FileHistorySnapshot,
  McpServerConnection,
  ModelSetting,
  Notification,
  ReplHookContext,
  ServerResource,
  TaskState,
  TodoList,
  Tool,
} from '../types/forward.js'
import type { AgentId } from '../types/ids.js'
import type { Message, UserMessage } from '../types/message.js'
import {
  getEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from '../types/permissions.js'
import type { LoadedPlugin, PluginError } from '../types/plugin.js'
import type { DeepImmutable } from '../types/utils.js'
import { getInitialSettings } from '../utilities/settings/settings.js'
import type { SettingsJson } from '../utilities/settings/types.js'
import type { Store } from './store.js'

export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] }
      writtenPathsRef: { current: Set<string> }
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: ReplHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type FooterItem =
  | 'tasks'
  | 'tmux'
  | 'bagel'
  | 'teams'
  | 'bridge'
  | 'companion'

type ImmutableAppStateSlice = {
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  showTeammateMessagePreview?: boolean
  selectedIpAgentIndex: number
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext
  spinnerTip?: string
  agent: string | undefined
  kairosEnabled: boolean
  remoteSessionUrl: string | undefined
  remoteConnectionStatus:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  remoteBackgroundTaskCount: number
  replBridgeEnabled: boolean
  replBridgeExplicit: boolean
  replBridgeOutboundOnly: boolean
  replBridgeConnected: boolean
  replBridgeSessionActive: boolean
  replBridgeReconnecting: boolean
  showRemoteCallout: boolean
  replBridgeConnectUrl: string | undefined
  replBridgeSessionUrl: string | undefined
  replBridgeEnvironmentId: string | undefined
  replBridgeSessionId: string | undefined
  replBridgeError: string | undefined
  replBridgeInitialName: string | undefined
}

type MutableAppStateSlice = {
  tasks: Record<string, TaskState>
  agentNameRegistry: Map<string, AgentId>
  foregroundedTaskId?: string
  viewingAgentTaskId?: string
  companionReaction?: string
  companionPetAt?: number
  mcp: {
    clients: McpServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    errors: PluginError[]
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    needsRefresh: boolean
  }
  agentDefinitions: {
    activeAgents: unknown[]
    allAgents: unknown[]
  }
  fileHistory: {
    snapshots: FileHistorySnapshot[]
    trackedFiles: Set<string>
    snapshotSequence: number
  }
  attribution: AttributionState
  todos: Record<string, TodoList>
  remoteAgentTaskSuggestions: Array<{ summary: string; task: string }>
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  elicitation: {
    queue: ElicitationRequestEvent[]
  }
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  sessionHooks: Map<string, unknown>
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: Array<{ section: string; change: string; reason: string }>
    } | null
  }
  authVersion: number
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    allowedPrompts?: AllowedPrompt[]
  } | null
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  denialTracking?: DenialTrackingState
  activeOverlays: ReadonlySet<string>
  fastMode?: boolean
  advisorModel?: string
  effortValue?: EffortValue
  ultraplanLaunching?: boolean
  ultraplanSessionUrl?: string
  ultraplanPendingChoice?: {
    plan: string
    sessionId: string
    taskId: string
  }
  ultraplanLaunchPending?: { blurb: string }
  isUltraplanMode?: boolean
  tungstenActiveSession?: unknown
  tungstenLastCapturedTime?: number
  tungstenLastCommand?: string
  tungstenPanelVisible?: boolean
  tungstenPanelAutoHidden?: boolean
  bagelActive?: boolean
  bagelUrl?: string
  bagelPanelVisible?: boolean
  computerUseMcpState?: unknown
  replContext?: unknown
  teamContext?: unknown
  standaloneAgentContext?: unknown
  replBridgePermissionCallbacks?: unknown
  channelPermissionCallbacks?: unknown
}

export type AppState = DeepImmutable<ImmutableAppStateSlice> &
  MutableAppStateSlice

export type AppStateStore = Store<AppState>

type DefaultAppStateHooks = {
  getInitialPermissionMode?: () => PermissionMode
  shouldEnableThinkingByDefault?: () => boolean | undefined
  shouldEnablePromptSuggestion?: () => boolean
}

let defaultAppStateHooks: DefaultAppStateHooks = {}

/**
 * Registers optional Phase 2+/9+/12+ resolvers for getDefaultAppState()
 * without introducing backward imports.
 */
export function registerDefaultAppStateHooks(
  hooks: Partial<DefaultAppStateHooks>,
): void {
  defaultAppStateHooks = { ...defaultAppStateHooks, ...hooks }
}

function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(),
    promptCount: 0,
    promptCountAtLastCommit: 0,
    permissionPromptCount: 0,
    permissionPromptCountAtLastCommit: 0,
    escapeCount: 0,
    escapeCountAtLastCommit: 0,
  }
}

export function getDefaultAppState(): AppState {
  const settings = getInitialSettings()
  const initialMode: PermissionMode =
    defaultAppStateHooks.getInitialPermissionMode?.() ?? 'default'
  const thinkingEnabled = defaultAppStateHooks.shouldEnableThinkingByDefault
    ? defaultAppStateHooks.shouldEnableThinkingByDefault()
    : settings.alwaysThinkingEnabled
  const promptSuggestionEnabled =
    defaultAppStateHooks.shouldEnablePromptSuggestion
      ? defaultAppStateHooks.shouldEnablePromptSuggestion()
      : settings.promptSuggestionEnabled !== false

  return {
    settings,
    verbose: false,
    mainLoopModel: null,
    mainLoopModelForSession: null,
    statusLineText: undefined,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIpAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    agent: undefined,
    kairosEnabled: false,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    replBridgeExplicit: false,
    replBridgeOutboundOnly: false,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    showRemoteCallout: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: undefined,
    tasks: {},
    agentNameRegistry: new Map(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    agentDefinitions: {
      activeAgents: [],
      allAgents: [],
    },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    todos: {},
    remoteAgentTaskSuggestions: [],
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled,
    promptSuggestionEnabled,
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    activeOverlays: new Set<string>(),
    fastMode: false,
    effortValue: undefined,
  }
}
