/**
 * Headless `-p` / `--print` execution loop (`runHeadless`) for Phase 2 (M1
 * Milestone): supports `text`, `json`, and initial `stream-json` output modes,
 * live text streaming, cost reporting, and clean exit-code handling.
 */

import {
  setMainLoopModelOverride,
  setSdkBetas,
} from '../bootstrap/state.js'
import {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
} from '../constants/tools.js'
import { formatTotalCost, saveCurrentSessionCosts } from '../cost_tracker.js'
import { QueryEngine } from '../query_engine.js'
import type { QueryDeps } from '../query/deps.js'
import {
  getDefaultAppState,
  type AppState,
} from '../state/app_state_store.js'
import { onChangeAppState } from '../state/on_change_app_state.js'
import { createStore } from '../state/store.js'
import type { AnyTool, ToolUseContext } from '../tool.js'
import { assembleToolPool } from '../tools.js'
import type { CanUseToolFn } from '../types/forward.js'
import type { PermissionMode, ToolPermissionContext } from '../types/permissions.js'
import { hasConsoleBillingAccess } from '../utilities/billing.js'
import { getCwd } from '../utilities/cwd.js'
import { parseEffortValue } from '../utilities/effort.js'
import { gracefulShutdownSync } from '../utilities/graceful_shutdown.js'
import { logHeadlessProfilerTurn } from '../utilities/headless_profiler.js'
import type { SdkMessage, SdkResultMessage } from '../utilities/messages/mappers.js'
import { cloneRulesBySource } from '../utilities/permissions/rule_matching.js'
import { writeToStdout } from '../utilities/process.js'
import { jsonStringify } from '../utilities/slow_operations.js'
import type { ThinkingConfig } from '../utilities/thinking.js'

export interface HeadlessRunOptions {
  outputFormat?: 'text' | 'json' | 'stream-json'
  inputFormat?: 'text' | 'stream-json'
  verbose?: boolean
  model?: string
  fallbackModel?: string
  effort?: string
  thinking?: 'enabled' | 'adaptive' | 'disabled'
  maxThinkingTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: number
  systemPrompt?: string
  appendSystemPrompt?: string
  betas?: string[]
  addDir?: string[]
  permissionMode?: PermissionMode
  dangerouslySkipPermissions?: boolean
  includePartialMessages?: boolean
  replayUserMessages?: boolean
  jsonSchema?: string | Record<string, unknown>
  tools?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Injectable test overrides */
  deps?: QueryDeps
  stdoutWriter?: (text: string) => void
  stderrWriter?: (text: string) => void
  skipExit?: boolean
}

function splitToolListArg(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  return values
    .flatMap(entry => entry.split(','))
    .map(token => token.trim())
    .filter(Boolean)
}

function parseJsonSchemaOption(
  raw: string | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object') return raw
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--json-schema must be a JSON object schema.')
  }
  return parsed as Record<string, unknown>
}

function resolveThinkingConfig(
  options: HeadlessRunOptions,
): ThinkingConfig | undefined {
  if (options.thinking === 'disabled') {
    return { type: 'disabled' }
  }
  if (options.thinking === 'adaptive') {
    return { type: 'adaptive' }
  }
  if (options.thinking === 'enabled') {
    return {
      type: 'enabled',
      budgetTokens: options.maxThinkingTokens ?? 10_000,
    }
  }
  if (options.maxThinkingTokens !== undefined) {
    return options.maxThinkingTokens > 0
      ? { type: 'enabled', budgetTokens: options.maxThinkingTokens }
      : { type: 'disabled' }
  }
  return undefined
}

/**
 * Executes a non-interactive headless prompt turn through `QueryEngine`,
 * streaming text/NDJSON or emitting formatted JSON and reporting session cost.
 */
export async function runHeadless(
  prompt: string,
  options: HeadlessRunOptions = {},
): Promise<{
  exitCode: number
  lastMessage?: SdkMessage
  messages: SdkMessage[]
}> {
  const writeOut = options.stdoutWriter ?? writeToStdout
  const writeErr =
    options.stderrWriter ?? ((text: string) => process.stderr.write(text))

  if (!prompt.trim()) {
    writeErr('Error: Input must be provided either through stdin or as a prompt argument when using --print.\n')
    if (!options.skipExit) {
      gracefulShutdownSync(1)
    }
    return { exitCode: 1, messages: [] }
  }

  if (options.betas && options.betas.length > 0) {
    setSdkBetas(options.betas)
  }
  if (options.model) {
    setMainLoopModelOverride(options.model)
  }

  const initialState = getDefaultAppState()
  const permissionMode: PermissionMode = options.dangerouslySkipPermissions
    ? 'bypassPermissions'
    : (options.permissionMode ?? initialState.toolPermissionContext.mode)
  const effortValue = options.effort
    ? parseEffortValue(options.effort)
    : initialState.effortValue

  const allowedCliRules = splitToolListArg(options.allowedTools)
  const disallowedCliRules = splitToolListArg(options.disallowedTools)
  const requestedTools = splitToolListArg(options.tools)
  const parsedJsonSchema = parseJsonSchemaOption(options.jsonSchema)

  const initialPermCtx: ToolPermissionContext = {
    ...initialState.toolPermissionContext,
    mode: permissionMode,
    additionalWorkingDirectories: new Map(
      initialState.toolPermissionContext.additionalWorkingDirectories,
    ),
    alwaysAllowRules: {
      ...cloneRulesBySource(initialState.toolPermissionContext.alwaysAllowRules),
      ...(allowedCliRules?.length ? { cliArg: allowedCliRules } : {}),
    },
    alwaysDenyRules: {
      ...cloneRulesBySource(initialState.toolPermissionContext.alwaysDenyRules),
      ...(disallowedCliRules?.length ? { cliArg: disallowedCliRules } : {}),
    },
    alwaysAskRules: cloneRulesBySource(
      initialState.toolPermissionContext.alwaysAskRules,
    ),
    ...(initialState.toolPermissionContext.strippedDangerousRules
      ? {
          strippedDangerousRules: cloneRulesBySource(
            initialState.toolPermissionContext.strippedDangerousRules,
          ),
        }
      : { strippedDangerousRules: undefined }),
  }

  const store = createStore<AppState>(
    {
      ...initialState,
      verbose: Boolean(options.verbose),
      effortValue,
      toolPermissionContext: initialPermCtx,
    },
    onChangeAppState,
  )

  const assembledTools = assembleToolPool(store.getState().toolPermissionContext, [], {
    ...(requestedTools !== undefined ? { allowedToolNames: requestedTools } : {}),
  })

  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
  ) => {
    const typedTool = tool as AnyTool | undefined
    if (
      typedTool?.name === SYNTHETIC_OUTPUT_TOOL_NAME ||
      typedTool?.name === TOOL_SEARCH_TOOL_NAME
    ) {
      return { behavior: 'allow', updatedInput: input }
    }

    if (typedTool && typeof typedTool.checkPermissions === 'function') {
      const decision = await typedTool.checkPermissions(
        input,
        toolUseContext as ToolUseContext,
      )
      if (decision.behavior === 'allow' || decision.behavior === 'deny') {
        return decision
      }
      if (permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input }
      }
      return {
        behavior: 'deny',
        message:
          'message' in decision && decision.message
            ? `${decision.message} (Non-interactive mode cannot prompt for approval; pass --allowed-tools or --dangerously-skip-permissions.)`
            : `Tool ${typedTool.name} requires interactive approval.`,
        decisionReason:
          decision.decisionReason ?? { type: 'mode', mode: permissionMode },
      }
    }

    if (permissionMode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input }
    }
    return {
      behavior: 'deny',
      message: 'Tool execution requires permission in non-interactive mode.',
      decisionReason: { type: 'mode', mode: permissionMode },
    }
  }

  const outputFormat = options.outputFormat ?? 'text'
  const isTextStreaming = outputFormat === 'text'

  const engine = new QueryEngine({
    cwd: getCwd(),
    tools: assembledTools,
    commands: [],
    mcpClients: [],
    canUseTool,
    getAppState: () => store.getState(),
    setAppState: updater => store.setState(updater),
    customSystemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    userSpecifiedModel: options.model,
    fallbackModel: options.fallbackModel,
    thinkingConfig: resolveThinkingConfig(options),
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    taskBudget:
      options.taskBudget !== undefined
        ? { total: options.taskBudget }
        : undefined,
    jsonSchema: parsedJsonSchema,
    verbose: options.verbose,
    replayUserMessages: options.replayUserMessages,
    includePartialMessages:
      Boolean(options.includePartialMessages) || isTextStreaming,
    additionalDirectories: options.addDir,
    deps: options.deps,
  })

  const needsFullArray = outputFormat === 'json' && Boolean(options.verbose)
  const messages: SdkMessage[] = []
  let lastMessage: SdkMessage | undefined
  let streamedTextChars = 0
  let streamedEndsWithNewline = false

  for await (const message of engine.submitMessage(prompt)) {
    if (outputFormat === 'stream-json') {
      if (
        message.type !== 'stream_event' ||
        Boolean(options.includePartialMessages)
      ) {
        writeOut(jsonStringify(message) + '\n')
      }
    } else if (
      isTextStreaming &&
      message.type === 'stream_event' &&
      message.event.type === 'content_block_delta' &&
      message.event.delta.type === 'text_delta'
    ) {
      const chunk = message.event.delta.text
      if (chunk.length > 0) {
        writeOut(chunk)
        streamedTextChars += chunk.length
        streamedEndsWithNewline = chunk.endsWith('\n')
      }
    }

    if (message.type !== 'stream_event') {
      if (needsFullArray) {
        messages.push(message)
      }
      lastMessage = message
    }
  }

  let exitCode = 0
  switch (outputFormat) {
    case 'json': {
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      if (options.verbose) {
        writeOut(jsonStringify(messages) + '\n')
      } else {
        writeOut(jsonStringify(lastMessage) + '\n')
      }
      exitCode = lastMessage.is_error ? 1 : 0
      break
    }

    case 'stream-json': {
      exitCode =
        lastMessage?.type === 'result' && lastMessage.is_error ? 1 : 0
      break
    }

    case 'text':
    default: {
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      const resultMsg = lastMessage as SdkResultMessage
      exitCode = resultMsg.is_error ? 1 : 0

      switch (resultMsg.subtype) {
        case 'success':
          if (streamedTextChars > 0) {
            if (!streamedEndsWithNewline) {
              writeOut('\n')
            }
          } else if (resultMsg.result.length > 0) {
            writeOut(
              resultMsg.result.endsWith('\n')
                ? resultMsg.result
                : resultMsg.result + '\n',
            )
          }
          break
        case 'error_during_execution':
          writeOut('Execution error\n')
          break
        case 'error_max_turns':
          writeOut(`Error: Reached max turns (${options.maxTurns ?? ''})\n`)
          break
        case 'error_max_budget_usd':
          writeOut(
            `Error: Exceeded USD budget (${options.maxBudgetUsd ?? ''})\n`,
          )
          break
        case 'error_max_structured_output_retries':
          writeOut(
            'Error: Failed to provide valid structured output after maximum retries\n',
          )
          break
        default:
          break
      }

      if (options.verbose || hasConsoleBillingAccess()) {
        writeErr('\n' + formatTotalCost() + '\n')
      }
      break
    }
  }

  logHeadlessProfilerTurn()
  saveCurrentSessionCosts()

  if (!options.skipExit) {
    gracefulShutdownSync(exitCode)
  }

  return { exitCode, lastMessage, messages }
}
