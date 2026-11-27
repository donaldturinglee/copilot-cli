/**
 * Generic `Tool<Input, Output, P>` contract, `ToolUseContext`, `buildTool()`
 * factory with fail-closed security defaults, and tool lookup helpers.
 *
 * Ink/React TUI rendering hooks are optional so Phase 3 executes purely
 * headlessly; TUI renderers attach incrementally in Phases 5–6.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { z } from 'zod/v4'
import type { AppState } from './state/app_state_store.js'
import type {
  ContentReplacementRecord,
  Notification,
  ToolUseContext as ForwardToolUseContext,
} from './types/forward.js'
import type { Message, ProgressMessage } from './types/message.js'
import type {
  PermissionDecision,
  PermissionMode,
  PermissionResult,
  ToolPermissionContext,
} from './types/permissions.js'
import type { ToolProgressData } from './types/tools.js'
import type { DeepImmutable } from './types/utils.js'
import type { ThinkingConfig } from './utilities/thinking.js'

export type AnyObject = Record<string, unknown>

export type ToolInputJsonSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      meta?: Record<string, unknown>
      errorCode?: number
    }

export type ToolProgress<P extends ToolProgressData = ToolProgressData> = {
  toolUseId: string
  data: P
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

export type ToolResult<T = unknown> = {
  data: T
  newMessages?: Message[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

export type ToolPromptOptions = {
  getToolPermissionContext: () => Promise<
    ToolPermissionContext | DeepImmutable<ToolPermissionContext>
  >
  tools: Tools
  agents: readonly unknown[]
  allowedAgentTypes?: string[]
}

export type ContentReplacementStateView = {
  seenIds: Set<string>
  replacements: Map<string, string>
  records?: ContentReplacementRecord[]
}

export type FileStateEntryLike = {
  content: string
  timestamp: number
  offset?: number
  limit?: number
  isPartialView?: boolean
}

export type FileStateCacheLike = {
  get(key: string): FileStateEntryLike | undefined
  set(key: string, value: FileStateEntryLike): unknown
  has(key: string): boolean
  delete(key: string): boolean
  clear(): void
  keys(): IterableIterator<string>
  entries(): IterableIterator<[string, FileStateEntryLike]>
  readonly size: number
}

export type ToolUseContextOptions = {
  mainLoopModel?: string
  tools?: Tools
  thinkingConfig?: ThinkingConfig
  isNonInteractiveSession?: boolean
  hasAppendSystemPrompt?: boolean
  refreshTools?: () => Tools
  verbose?: boolean
  maxThinkingTokens?: number
  mcpClients?: readonly unknown[]
  commands?: readonly unknown[]
  agentDefinitions?: {
    activeAgents: readonly unknown[]
    allAgents: readonly unknown[]
  }
  [key: string]: unknown
}

export type ToolUseContext = ForwardToolUseContext & {
  abortController: AbortController
  messages: Message[]
  options?: ToolUseContextOptions
  readFileState?: FileStateCacheLike
  getAppState?: () => AppState
  setAppState?: (updater: (prev: AppState) => AppState) => void
  contentReplacementState?: ContentReplacementStateView
  agentId?: string
  agentType?: string
  queryTracking?: {
    chainId: string
    depth: number
  }
  discoveredSkillNames?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  nestedMemoryAttachmentTriggers?: Set<string>
  addNotification?: (notification: Notification) => void
  setToolJSX?: (jsx: unknown) => void
  setResponseLength?: (updater: (prev: number) => number) => void
  toolDecisions?: Map<string, PermissionDecision>
  permissionMode?: PermissionMode
}

export type InterruptBehavior = 'cancel' | 'block'

export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly searchHint?: string
  readonly maxResultSizeChars: number
  readonly shouldDefer?: boolean
  readonly alwaysLoad?: boolean
  readonly isMcp?: boolean
  readonly mcpInfo?: { serverName: string; toolName: string }
  readonly strict?: boolean
  readonly eagerInputStreaming?: boolean
  readonly inputSchema: z.ZodType<Input>
  readonly inputJSONSchema?: ToolInputJsonSchema
  readonly outputSchema?: z.ZodType<Output>

  call(
    args: Input,
    context: ToolUseContext,
    canUseTool: unknown,
    parentMessage: unknown,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>

  description(input: Input, options: ToolPromptOptions): Promise<string>
  prompt(options: ToolPromptOptions): Promise<string>
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam

  // Optional overrides with fail-closed defaults provided by buildTool()
  isEnabled?(): boolean
  isConcurrencySafe?(input: Input): boolean
  isReadOnly?(input: Input): boolean
  isDestructive?(input: Input): boolean
  isOpenWorld?(input: Input): boolean
  isSearchOrReadCommand?(input: Input): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  interruptBehavior?(): InterruptBehavior
  requiresUserInteraction?(): boolean
  checkPermissions?(
    input: Input,
    context: ToolUseContext,
  ): Promise<PermissionResult<Input>>
  validateInput?(
    input: Input,
    context: ToolUseContext,
  ): Promise<ValidationResult>
  backfillObservableInput?(input: Record<string, unknown>): void
  getPath?(input: Input): string
  toAutoClassifierInput?(input: Input): string
  userFacingName?(input?: Partial<Input>): string
  userFacingNameBackgroundColor?(input?: Partial<Input>): string | undefined
  getToolUseSummary?(input?: Partial<Input>): string | null
  getActivityDescription?(input?: Partial<Input>): string | null
  preparePermissionMatcher?(
    input: Input,
  ): Promise<(pattern: string) => boolean>

  // Optional Ink/React rendering hooks (wired in Phases 5–6)
  renderToolUseMessage?(input: Partial<Input>, options: Record<string, unknown>): unknown
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: Record<string, unknown>,
  ): unknown
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: Record<string, unknown>,
  ): unknown
  renderToolUseRejectedMessage?(
    input: Input,
    options: Record<string, unknown>,
  ): unknown
  renderToolUseErrorMessage?(
    result: unknown,
    options: Record<string, unknown>,
  ): unknown
}

export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = ToolDef<Input, Output, P> & {
  isEnabled(): boolean
  isConcurrencySafe(input: Input): boolean
  isReadOnly(input: Input): boolean
  isDestructive(input: Input): boolean
  interruptBehavior(): InterruptBehavior
  checkPermissions(
    input: Input,
    context: ToolUseContext,
  ): Promise<PermissionResult<Input>>
  toAutoClassifierInput(input: Input): string
  userFacingName(input?: Partial<Input>): string
}

/**
 * Erased tool representation accepted in heterogeneous tool pools and registries
 * without resorting to `any`. Method signatures on `Tool` are bivariant under
 * TypeScript's method-shorthand rules, while `inputSchema` is widened to
 * `z.ZodType`.
 */
export type AnyTool = Omit<
  Tool<AnyObject, unknown, ToolProgressData>,
  'inputSchema' | 'outputSchema'
> & {
  readonly inputSchema: z.ZodType
  readonly outputSchema?: z.ZodType
}

export type Tools = readonly AnyTool[]

/**
 * Constructs a `Tool` with fail-closed security defaults:
 * - `isEnabled`: `() => true`
 * - `isConcurrencySafe`: `() => false` (serial by default)
 * - `isReadOnly`: `() => false` (write/mutating by default)
 * - `isDestructive`: `() => false`
 * - `interruptBehavior`: `() => 'block'`
 * - `checkPermissions`: allows input pass-through (overridden by permission engine / tools)
 * - `toAutoClassifierInput`: `() => ''`
 * - `userFacingName`: `() => def.name`
 */
export function buildTool<
  Input extends AnyObject,
  Output,
  P extends ToolProgressData = ToolProgressData,
>(def: ToolDef<Input, Output, P>): Tool<Input, Output, P> {
  return {
    ...def,
    isEnabled: def.isEnabled ?? (() => true),
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    isReadOnly: def.isReadOnly ?? (() => false),
    isDestructive: def.isDestructive ?? (() => false),
    interruptBehavior: def.interruptBehavior ?? (() => 'block'),
    checkPermissions:
      def.checkPermissions ??
      (async (input: Input) => ({
        behavior: 'allow',
        updatedInput: input,
      })),
    toAutoClassifierInput: def.toAutoClassifierInput ?? (() => ''),
    userFacingName: def.userFacingName ?? (() => def.name),
  }
}

/**
 * Upcasts a strongly-typed `Tool<Input, Output, P>` into `AnyTool` for
 * heterogeneous tool pools while preserving all runtime methods and schemas.
 */
export function asAnyTool<
  Input extends AnyObject,
  Output,
  P extends ToolProgressData,
>(tool: Tool<Input, Output, P>): AnyTool {
  return tool as unknown as AnyTool
}

/**
 * Checks whether a tool matches `name` by canonical name or any declared alias.
 */
export function toolMatchesName(
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  name: string,
): boolean {
  if (tool.name === name) {
    return true
  }
  return tool.aliases?.includes(name) === true
}

/**
 * Finds the first tool matching `name` by canonical name or alias.
 */
export function findToolByName(
  tools: Tools,
  name: string,
): AnyTool | undefined {
  return tools.find(tool => toolMatchesName(tool, name))
}

/**
 * Filters out `progress` messages from a message array.
 */
export function filterToolProgressMessages(
  messages: readonly Message[],
): Message[] {
  return messages.filter(msg => msg.type !== 'progress')
}
