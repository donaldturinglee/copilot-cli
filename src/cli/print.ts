/**
 * Headless `-p` / `--print` execution loop (`runHeadless`) for Phase 2 (M1
 * Milestone): supports `text`, `json`, and initial `stream-json` output modes,
 * live text streaming, cost reporting, and clean exit-code handling.
 */

import type { UUID } from 'crypto'
import {
  setMainLoopModelOverride,
  setSdkBetas,
} from '../bootstrap/state.js'
import { formatTotalCost, saveCurrentSessionCosts } from '../cost_tracker.js'
import { createCanUseTool } from '../hooks/tool_permission/use_can_use_tool.js'
import { QueryEngine } from '../query_engine.js'
import type { QueryDeps } from '../query/deps.js'
import { drainPendingExtraction } from '../services/extract_memories/extract_memories.js'
import type {
  McpServerConnection,
  ScopedMcpServerConfig,
} from '../services/mcp/types.js'
import {
  getDefaultAppState,
  type AppState,
} from '../state/app_state_store.js'
import { onChangeAppState } from '../state/on_change_app_state.js'
import { createStore } from '../state/store.js'
import type { AnyTool } from '../tool.js'
import { assembleToolPool } from '../tools.js'
import type { Command } from '../types/command.js'
import type { Message } from '../types/message.js'
import type { PermissionMode, ToolPermissionContext } from '../types/permissions.js'
import { hasConsoleBillingAccess } from '../utilities/billing.js'
import { loadConversationForResume } from '../utilities/conversation_recovery.js'
import { getCwd } from '../utilities/cwd.js'
import { parseEffortValue } from '../utilities/effort.js'
import { isBareMode, isEnvTruthy } from '../utilities/env_utils.js'
import {
  createEmptyFileHistoryState,
  fileHistoryRestoreStateFromLog,
  fileHistoryRewind,
  type FileHistoryState,
} from '../utilities/file_history.js'
import { gracefulShutdownSync } from '../utilities/graceful_shutdown.js'
import { logHeadlessProfilerTurn } from '../utilities/headless_profiler.js'
import {
  executeSessionEndHooks,
  executeSessionStartHooks,
} from '../utilities/hooks.js'
import { ensurePhase4HooksBootstrapped } from '../utilities/hooks/bootstrap_hooks.js'
import type { SdkMessage, SdkResultMessage } from '../utilities/messages/mappers.js'
import { loadToolPermissionContextFromSettings } from '../utilities/permissions/permissions_loader.js'
import { writeToStdout } from '../utilities/process.js'
import { processResumedConversation } from '../utilities/session_restore.js'
import { flushSessionStorage } from '../utilities/session_storage.js'
import { parseSessionIdentifier } from '../utilities/session_url.js'
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
  mcpConfig?: string[]
  strictMcpConfig?: boolean
  continue?: boolean
  resume?: string | boolean
  forkSession?: boolean
  resumeSessionAt?: string
  rewindFiles?: string
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

  // Handle `--rewind-files <userMessageUuid>` headless file restoration
  if (options.rewindFiles) {
    const sourceId =
      typeof options.resume === 'string' ? options.resume : undefined
    const parsedId = sourceId ? parseSessionIdentifier(sourceId) : null
    const loaded = await loadConversationForResume(
      parsedId?.kind === 'session_id' ? parsedId.sessionId : sourceId,
      parsedId?.kind === 'jsonl_file' ? parsedId.path : undefined,
      { skipSessionStartHooks: true },
    )
    if (!loaded) {
      writeErr('Error: No session found to rewind files.\n')
      if (!options.skipExit) gracefulShutdownSync(1)
      return { exitCode: 1, messages: [] }
    }
    let restoredFileHistory: FileHistoryState = createEmptyFileHistoryState()
    if (loaded.log.fileHistorySnapshots?.length) {
      fileHistoryRestoreStateFromLog(loaded.log.fileHistorySnapshots, next => {
        restoredFileHistory = next
      })
    }
    await fileHistoryRewind(
      updater => {
        restoredFileHistory = updater(restoredFileHistory)
      },
      options.rewindFiles as UUID,
    )
    writeOut(`Restored files to checkpoint ${options.rewindFiles}\n`)
    await flushSessionStorage()
    if (!options.skipExit) gracefulShutdownSync(0)
    return { exitCode: 0, messages: [] }
  }

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

  ensurePhase4HooksBootstrapped()

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

  const initialPermCtx: ToolPermissionContext =
    loadToolPermissionContextFromSettings({
      modeOverride: permissionMode,
      allowedCliRules,
      disallowedCliRules,
      additionalDirectories: options.addDir,
      shouldAvoidPermissionPrompts: true,
      isBypassPermissionsModeAvailable: Boolean(
        options.dangerouslySkipPermissions,
      ),
    })

  let resumedMessages: Message[] | undefined
  let resumedFileHistory: FileHistoryState = initialState.fileHistory
  if (options.continue || options.resume) {
    const resumeArg =
      typeof options.resume === 'string' ? options.resume : undefined
    const parsed = resumeArg ? parseSessionIdentifier(resumeArg) : null
    const loaded = await loadConversationForResume(
      parsed?.kind === 'session_id' ? parsed.sessionId : resumeArg,
      parsed?.kind === 'jsonl_file' ? parsed.path : undefined,
    )
    if (loaded) {
      const processed = await processResumedConversation(
        loaded.log,
        loaded.messages,
        {
          forkSession: Boolean(options.forkSession),
          resumeSessionAt: options.resumeSessionAt,
        },
      )
      resumedMessages = processed.messages
      if (loaded.log.fileHistorySnapshots?.length) {
        fileHistoryRestoreStateFromLog(loaded.log.fileHistorySnapshots, next => {
          resumedFileHistory = next
        })
      }
    }
  }

  const store = createStore<AppState>(
    {
      ...initialState,
      verbose: Boolean(options.verbose),
      effortValue,
      toolPermissionContext: initialPermCtx,
      fileHistory: resumedFileHistory,
    },
    onChangeAppState,
  )

  const skipExtensions =
    isBareMode() || isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)

  let loadedCommands: Command[] = []
  let mcpTools: AnyTool[] = []
  let mcpCommands: Command[] = []
  let mcpClients: McpServerConnection[] = []

  if (!skipExtensions) {
    const [
      { initBundledSkills, getBundledSkillCommands },
      { getSkillDirCommands },
      { getPluginCommands },
      { loadPluginHooks },
    ] = await Promise.all([
      import('../skills/bundled/index.js'),
      import('../skills/load_skills_dir.js'),
      import('../utilities/plugins/load_plugin_commands.js'),
      import('../utilities/plugins/load_plugin_hooks.js'),
    ])
    initBundledSkills()
    await loadPluginHooks().catch(() => 0)
    const [diskSkills, pluginCmds] = await Promise.all([
      getSkillDirCommands(getCwd()).catch(() => [] as Command[]),
      getPluginCommands().catch(() => [] as Command[]),
    ])
    loadedCommands = [...getBundledSkillCommands(), ...diskSkills, ...pluginCmds]
  }

  if (
    !skipExtensions ||
    (options.mcpConfig && options.mcpConfig.length > 0)
  ) {
    const { getAllMcpConfigs, parseMcpConfigsFromCli } = await import(
      '../services/mcp/config.js'
    )
    let targetConfigs: Record<string, ScopedMcpServerConfig> = {}
    if (options.strictMcpConfig) {
      if (options.mcpConfig && options.mcpConfig.length > 0) {
        const parsedCli = parseMcpConfigsFromCli(options.mcpConfig)
        targetConfigs = parsedCli.servers
      }
    } else {
      const baseConfigs = await getAllMcpConfigs({ includeClaudeAi: false })
      targetConfigs = { ...baseConfigs.servers }
      if (options.mcpConfig && options.mcpConfig.length > 0) {
        const parsedCli = parseMcpConfigsFromCli(options.mcpConfig)
        Object.assign(targetConfigs, parsedCli.servers)
      }
    }

    const serverEntries = Object.entries(targetConfigs)
    if (serverEntries.length > 0) {
      const { getMcpToolsCommandsAndResources } = await import(
        '../services/mcp/client.js'
      )
      const mcpResult = await getMcpToolsCommandsAndResources(targetConfigs)
      mcpClients = mcpResult.clients
      mcpTools = mcpResult.tools
      mcpCommands = mcpResult.commands
      store.setState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: mcpClients as unknown as AppState['mcp']['clients'],
          tools: mcpTools as unknown as AppState['mcp']['tools'],
          commands: mcpCommands,
          resources: mcpResult.resources as unknown as AppState['mcp']['resources'],
        },
      }))
    }
  }

  const allCommands = [...loadedCommands, ...mcpCommands]
  const assembledTools = assembleToolPool(
    store.getState().toolPermissionContext,
    mcpTools,
    {
      ...(requestedTools !== undefined ? { allowedToolNames: requestedTools } : {}),
    },
  )

  const canUseTool = createCanUseTool()

  const sessionStartResult = await executeSessionStartHooks({
    source: 'startup',
    model: options.model,
    permissionMode: initialPermCtx.mode,
  })
  const sessionStartContext =
    sessionStartResult.additionalContexts.length > 0
      ? sessionStartResult.additionalContexts.join('\n\n')
      : undefined
  const effectiveAppendSystemPrompt = [
    options.appendSystemPrompt,
    sessionStartContext,
  ]
    .filter(Boolean)
    .join('\n\n') || undefined

  const outputFormat = options.outputFormat ?? 'text'
  const isTextStreaming = outputFormat === 'text'

  const engine = new QueryEngine({
    cwd: getCwd(),
    tools: assembledTools,
    commands: allCommands,
    mcpClients: mcpClients as unknown as readonly import('../types/forward.js').McpServerConnection[],
    canUseTool,
    getAppState: () => store.getState(),
    setAppState: updater => store.setState(updater),
    initialMessages: resumedMessages,
    customSystemPrompt: options.systemPrompt,
    appendSystemPrompt: effectiveAppendSystemPrompt,
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

  await executeSessionEndHooks({
    reason: exitCode === 0 ? 'other' : 'error',
    permissionMode: store.getState().toolPermissionContext.mode,
  })

  logHeadlessProfilerTurn()
  saveCurrentSessionCosts()
  await drainPendingExtraction()
  if (mcpClients.length > 0) {
    const { cleanupAllMcpClients } = await import('../services/mcp/client.js')
    await cleanupAllMcpClients().catch(() => {})
  }
  await flushSessionStorage()

  if (!options.skipExit) {
    gracefulShutdownSync(exitCode)
  }

  return { exitCode, lastMessage, messages }
}
