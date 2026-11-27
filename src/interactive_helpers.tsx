import { getAllCommands } from './commands.js'
import type { CommandRuntimeHooks } from './commands/session_commands.js'
import { QueryEngine } from './query_engine.js'
import type { QueryDeps } from './query/deps.js'
import type { AppState } from './state/app_state_store.js'
import type { AnyTool } from './tool.js'
import { assembleToolPool } from './tools.js'
import type { Command, LocalJsxCommandContext } from './types/command.js'
import type { CanUseToolFn, ThemeName } from './types/forward.js'
import type { Message } from './types/message.js'
import { getCwd } from './utilities/cwd.js'
import { createFileStateCache } from './utilities/query_helpers.js'

export function createInteractiveQueryEngine(params: {
  cwd?: string
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  userSpecifiedModel?: string
  commands?: Command[]
  deps?: QueryDeps
}): QueryEngine {
  const appState = params.getAppState()
  const tools = assembleToolPool(
    appState.toolPermissionContext,
    appState.mcp.tools as unknown as readonly AnyTool[],
  )
  return new QueryEngine({
    cwd: params.cwd ?? getCwd(),
    tools,
    commands: params.commands ?? getAllCommands(),
    mcpClients: appState.mcp.clients,
    canUseTool: params.canUseTool,
    getAppState: params.getAppState,
    setAppState: params.setAppState,
    initialMessages: params.initialMessages,
    userSpecifiedModel: params.userSpecifiedModel,
    includePartialMessages: true,
    isNonInteractiveSession: false,
    deps: params.deps,
  })
}

export function buildReplCommandContext(params: {
  messages: Message[]
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  abortController: AbortController
  theme: ThemeName
  canUseTool?: CanUseToolFn
  runtime: CommandRuntimeHooks
  readFileState?: ReturnType<typeof createFileStateCache>
}): LocalJsxCommandContext {
  const ctx: LocalJsxCommandContext = {
    abortController: params.abortController,
    messages: params.messages,
    setMessages: params.setMessages,
    canUseTool: params.canUseTool,
    readFileState: params.readFileState ?? createFileStateCache(),
    options: {
      ideInstallationStatus: null,
      theme: params.theme,
    },
    onChangeApiKey: () => {},
    ...params.runtime,
  }
  return ctx
}
