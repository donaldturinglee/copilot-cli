/**
 * Complete 27-event Lifecycle Hooks Engine (`src/utilities/hooks.ts`).
 *
 * Supports:
 * - Startup config snapshotting (`getHooksConfigFromSnapshot`), programmatic
 *   `registeredHooks` (SDK/plugins), and `AppState.sessionHooks`
 * - Enterprise policy gates (`disableAllHooks`, `allowManagedHooksOnly`) and
 *   workspace trust gate (`shouldSkipHookDueToTrust`)
 * - `matcher` regex/glob filtering AND AST-backed `if` permission-rule filtering
 * - All 4 configurable executors (`command` with exit-code-2 blocking,
 *   `AsyncHookRegistry`, and interactive `PromptRequest` elicitation; `http`
 *   with SSRF & header-injection guards; `prompt`; `agent`) plus `callback`
 *   and `function` hooks
 * - Strict `PreToolUse` aggregation (`deny > ask > allow`, `updatedInput` chaining)
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  addToTurnHookDuration,
  getIsInteractive,
  getRegisteredHooks,
  getSessionId,
  getSessionTrustAccepted,
} from '../bootstrap/state.js'
import { getTranscriptPath as getSessionTranscriptPath } from './session_storage.js'
import type {
  BashCommandHook,
  HookCommand,
  HookMatcher,
} from '../schemas/hooks.js'
import type { ToolUseContext } from '../tool.js'
import {
  type AggregatedHookResult,
  type BaseHookInput,
  type HookBlockingError,
  type HookCallback,
  type HookEvent,
  type HookFunction,
  type HookInput,
  type HookJSONOutput,
  hookJSONOutputSchema,
  type HookResult,
  isAsyncHookJSONOutput,
  type PermissionRequestResult,
  type PromptRequest,
  promptRequestSchema,
  type PromptResponse,
  type SyncHookJSONOutput,
} from '../types/hooks.js'
import type { Message } from '../types/message.js'
import type { PermissionMode, PermissionUpdate } from '../types/permissions.js'
import { getCurrentProjectConfig } from './config.js'
import { createCombinedAbortSignal } from './combined_abort_signal.js'
import { randomUUID } from './crypto.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './env_utils.js'
import { errorMessage } from './errors.js'
import {
  completePendingAsyncHook,
  registerPendingAsyncHook,
} from './hooks/async_hook_registry.js'
import { execAgentHook } from './hooks/exec_agent_hook.js'
import { execHttpHook } from './hooks/exec_http_hook.js'
import { execPromptHook } from './hooks/exec_prompt_hook.js'
import { emitHookResponse, emitHookStarted } from './hooks/hook_events.js'
import { matchesHookIfCondition, matchesHookMatcher } from './hooks/hook_helpers.js'
import {
  getHooksConfigFromSnapshot,
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from './hooks/hooks_config_snapshot.js'
import {
  getSessionHooks,
  type RegisteredSessionHook,
} from './hooks/session_hooks.js'
import { getPluginDataDir } from './plugins/plugin_directories.js'
import {
  loadPluginOptions,
  substituteUserConfigInContent,
} from './plugins/plugin_options_storage.js'
import { findSuitableShell, exec as execShell } from './shell.js'
import { findPowerShell } from './shell/powershell_detection.js'
import { jsonParse, jsonStringify } from './slow_operations.js'

const DEFAULT_COMMAND_HOOK_TIMEOUT_MS = 60_000

export type HookPromptResponder = (
  request: PromptRequest,
) => Promise<PromptResponse | null>

let interactivePromptResponder: HookPromptResponder | null = null
const executedOnceHooks = new Set<string>()

export function registerHookPromptResponder(
  responder: HookPromptResponder | null,
): void {
  interactivePromptResponder = responder
}

export function resetOnceHooksForTesting(): void {
  executedOnceHooks.clear()
}

export function getTranscriptPath(): string {
  return getSessionTranscriptPath()
}

export function createBaseHookInput(
  permissionMode?: PermissionMode,
  agent?: { agentId?: string; agentType?: string },
): BaseHookInput {
  return {
    session_id: getSessionId(),
    transcript_path: getTranscriptPath(),
    cwd: getCwd(),
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    ...(agent?.agentId ? { agent_id: agent.agentId } : {}),
    ...(agent?.agentType ? { agent_type: agent.agentType } : {}),
  }
}

/**
 * Trust gate for non-managed workspace hooks:
 * - Non-interactive (`-p` / headless / SDK) sessions have implicit trust because
 *   the caller explicitly invoked CLI against the workspace.
 * - Interactive sessions require explicit workspace trust (`sessionTrustAccepted`
 *   or persisted `projectConfig.hasTrustDialogAccepted`).
 */
export function shouldSkipHookDueToTrust(options?: {
  isManaged?: boolean
  isNonInteractive?: boolean
}): boolean {
  if (options?.isManaged) return false
  if (options?.isNonInteractive === true || !getIsInteractive()) {
    return false
  }
  if (getSessionTrustAccepted()) {
    return false
  }
  try {
    return !getCurrentProjectConfig().hasTrustDialogAccepted
  } catch {
    return true
  }
}

/**
 * Parses raw hook stdout into a validated `HookJSONOutput` if stdout contains
 * a JSON object (supporting either full-body JSON or the last JSON line).
 */
export function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { plainText: '' }
  }

  const tryParseCandidate = (candidate: string): HookJSONOutput | 'not_json' | { error: string } => {
    if (!candidate.startsWith('{')) return 'not_json'
    let raw: unknown
    try {
      raw = jsonParse(candidate)
    } catch {
      return 'not_json'
    }
    const validated = hookJSONOutputSchema().safeParse(raw)
    if (!validated.success) {
      return { error: validated.error.message }
    }
    return validated.data
  }

  const whole = tryParseCandidate(trimmed)
  if (whole !== 'not_json') {
    if ('error' in whole) {
      return { plainText: trimmed, validationError: whole.error }
    }
    return { json: whole, plainText: '' }
  }

  // Fallback: inspect last non-empty line for trailing JSON output
  const lines = trimmed.split(/\r?\n/).filter(l => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i]!.trim()
    const res = tryParseCandidate(candidate)
    if (res !== 'not_json') {
      if ('error' in res) {
        return { plainText: trimmed, validationError: res.error }
      }
      return { json: res, plainText: lines.slice(0, i).join('\n') }
    }
  }

  return { plainText: trimmed }
}

/**
 * Converts validated `SyncHookJSONOutput` into normalized `HookResult`.
 */
export function processHookJSONOutput(
  json: SyncHookJSONOutput,
  hookEvent: HookEvent,
  commandLabel: string,
): HookResult {
  const result: HookResult = {
    outcome: 'success',
  }

  if (json.continue === false) {
    result.preventContinuation = true
    result.stopReason = json.stopReason ?? json.reason
  }

  if (json.decision === 'block') {
    result.outcome = 'blocking'
    const reason = json.reason ?? `Blocked by ${hookEvent} hook`
    result.blockingError = {
      blockingError: reason,
      command: commandLabel,
    }
    if (hookEvent === 'PreToolUse') {
      result.permissionBehavior = 'deny'
      result.hookPermissionDecisionReason = reason
    }
  } else if (json.decision === 'approve' && hookEvent === 'PreToolUse') {
    result.permissionBehavior = 'allow'
    result.hookPermissionDecisionReason = json.reason
  }

  const specific = json.hookSpecificOutput
  if (specific) {
    switch (specific.hookEventName) {
      case 'PreToolUse':
        if (specific.permissionDecision) {
          result.permissionBehavior = specific.permissionDecision
          if (specific.permissionDecision === 'deny') {
            result.outcome = 'blocking'
            result.blockingError = {
              blockingError:
                specific.permissionDecisionReason ??
                json.reason ??
                'Denied by PreToolUse hook',
              command: commandLabel,
            }
          }
        }
        if (specific.permissionDecisionReason) {
          result.hookPermissionDecisionReason = specific.permissionDecisionReason
        }
        if (specific.updatedInput) {
          result.updatedInput = specific.updatedInput
        }
        if (specific.additionalContext) {
          result.additionalContext = specific.additionalContext
        }
        break
      case 'PostToolUse':
        if (specific.additionalContext) {
          result.additionalContext = specific.additionalContext
        }
        if (specific.updatedMCPToolOutput !== undefined) {
          result.updatedMCPToolOutput = specific.updatedMCPToolOutput
        }
        break
      case 'PostToolUseFailure':
      case 'UserPromptSubmit':
      case 'Setup':
      case 'SubagentStart':
      case 'Notification':
        if (specific.additionalContext) {
          result.additionalContext = specific.additionalContext
        }
        break
      case 'SessionStart':
        if (specific.additionalContext) {
          result.additionalContext = specific.additionalContext
        }
        if (specific.initialUserMessage) {
          result.initialUserMessage = specific.initialUserMessage
        }
        if (specific.watchPaths) {
          result.watchPaths = specific.watchPaths
        }
        break
      case 'PermissionDenied':
        if (specific.retry !== undefined) {
          result.retry = specific.retry
        }
        break
      case 'PermissionRequest':
        result.permissionRequestResult = specific.decision
        break
      case 'CwdChanged':
      case 'FileChanged':
        if (specific.watchPaths) {
          result.watchPaths = specific.watchPaths
        }
        break
      case 'WorktreeCreate':
        result.worktreePath = specific.worktreePath
        break
      case 'Elicitation':
      case 'ElicitationResult':
        break
    }
  }

  return result
}

function resolveCommandShell(hook: BashCommandHook): {
  executable: string
  args: string[]
} | null {
  if (hook.shell === 'powershell') {
    const ps = findPowerShell()
    if (!ps) return null
    const encoded = Buffer.from(hook.command, 'utf16le').toString('base64')
    return {
      executable: ps.path,
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    }
  }

  const bash = findSuitableShell()
  if (bash) {
    return {
      executable: bash,
      args: ['-c', hook.command],
    }
  }

  // Fallback on Windows when Git Bash is unavailable
  if (process.platform === 'win32') {
    const ps = findPowerShell()
    if (ps) {
      const encoded = Buffer.from(hook.command, 'utf16le').toString('base64')
      return {
        executable: ps.path,
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      }
    }
  }

  return null
}

/**
 * Executes a `type: 'command'` hook with stdin JSON payload, exit-code-2
 * blocking semantics, optional `async`/`asyncRewake` background execution via
 * `AsyncHookRegistry`, and interactive `PromptRequest` stdin/stdout elicitation.
 */
function substituteHookVariables(
  raw: string,
  meta?: {
    pluginRoot?: string
    pluginId?: string
    skillRoot?: string
  },
): string {
  let out = raw
  if (meta?.pluginRoot) {
    out = out
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, meta.pluginRoot)
      .replace(/\$\{COPILOT_PLUGIN_ROOT\}/g, meta.pluginRoot)
  }
  if (meta?.pluginId) {
    const dataDir = getPluginDataDir(meta.pluginId)
    out = out
      .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir)
      .replace(/\$\{COPILOT_PLUGIN_DATA\}/g, dataDir)
    const opts = loadPluginOptions(meta.pluginId)
    if (Object.keys(opts).length > 0) {
      out = substituteUserConfigInContent(out, opts)
    }
  }
  if (meta?.skillRoot) {
    out = out
      .replace(/\$\{CLAUDE_SKILL_DIR\}/g, meta.skillRoot)
      .replace(/\$\{COPILOT_SKILL_DIR\}/g, meta.skillRoot)
  }
  return out
}

async function execCommandHook(
  hook: BashCommandHook,
  hookEvent: HookEvent,
  hookName: string,
  jsonInput: string,
  toolName: string | undefined,
  signal?: AbortSignal,
  hookMeta?: {
    pluginRoot?: string
    pluginId?: string
    skillRoot?: string
  },
): Promise<HookResult> {
  if (hookMeta?.pluginRoot && !existsSync(hookMeta.pluginRoot)) {
    logForDebugging(
      `Skipping command hook "${hookName}" because plugin root no longer exists: ${hookMeta.pluginRoot}`,
    )
    return { outcome: 'success' }
  }

  const expandedCommand = substituteHookVariables(hook.command, hookMeta)
  const effectiveHook: BashCommandHook =
    expandedCommand === hook.command ? hook : { ...hook, command: expandedCommand }
  const pluginDataDir = hookMeta?.pluginId
    ? getPluginDataDir(hookMeta.pluginId)
    : undefined
  const extraHookEnv: Record<string, string> = {
    ...(hookMeta?.pluginRoot
      ? {
          CLAUDE_PLUGIN_ROOT: hookMeta.pluginRoot,
          COPILOT_PLUGIN_ROOT: hookMeta.pluginRoot,
        }
      : {}),
    ...(pluginDataDir
      ? {
          CLAUDE_PLUGIN_DATA: pluginDataDir,
          COPILOT_PLUGIN_DATA: pluginDataDir,
        }
      : {}),
    ...(hookMeta?.skillRoot
      ? {
          CLAUDE_SKILL_DIR: hookMeta.skillRoot,
          COPILOT_SKILL_DIR: hookMeta.skillRoot,
        }
      : {}),
  }

  const hookId = randomUUID()
  emitHookStarted({ hookId, hookName, hookEvent })

  // Async background command hook (`async: true` or `asyncRewake: true`)
  if (effectiveHook.async || effectiveHook.asyncRewake) {
    const shellKind = effectiveHook.shell === 'powershell' ? 'powershell' : 'bash'
    const escapedInput = jsonInput.replace(/'/g, "'\\''")
    const wrappedCommand =
      shellKind === 'powershell'
        ? `$inputJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(jsonInput, 'utf8').toString('base64')}')); $inputJson | & { ${effectiveHook.command} }`
        : `printf '%s' '${escapedInput}' | (${effectiveHook.command})`

    let taskIdRef = ''
    let earlyExitResult: import('./shell_command.js').ExecResult | undefined

    const shellCmd = await execShell(wrappedCommand, signal, shellKind, {
      cwd: getCwd(),
      env: extraHookEnv,
      runInBackground: true,
      timeoutMs: (effectiveHook.timeout ?? 60) * 1000,
      onBackgroundExit: result => {
        if (taskIdRef) {
          completePendingAsyncHook(taskIdRef, result)
        } else {
          earlyExitResult = result
        }
      },
    })
    taskIdRef = shellCmd.taskId

    registerPendingAsyncHook({
      processId: shellCmd.taskId,
      hookId,
      asyncResponse: {
        async: true,
        asyncTimeout: (effectiveHook.timeout ?? 60) * 1000,
      },
      hookName,
      hookEvent,
      command: effectiveHook.command,
      shellCommand: shellCmd,
      toolName,
      asyncRewake: effectiveHook.asyncRewake,
    })

    if (earlyExitResult) {
      completePendingAsyncHook(shellCmd.taskId, earlyExitResult)
    }

    return { outcome: 'success' }
  }

  const shellSpec = resolveCommandShell(effectiveHook)
  if (!shellSpec) {
    return {
      outcome: 'non_blocking_error',
      hookPermissionDecisionReason: 'No shell executable found to run command hook',
    }
  }

  const timeoutMs = effectiveHook.timeout
    ? effectiveHook.timeout * 1000
    : DEFAULT_COMMAND_HOOK_TIMEOUT_MS
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
  })

  return new Promise<HookResult>(resolvePromise => {
    const child = spawn(shellSpec.executable, shellSpec.args, {
      cwd: getCwd(),
      env: {
        ...process.env,
        COPILOT_CLI_PROJECT_DIR: getCwd(),
        COPILOT_CLI_HOOK_EVENT: hookEvent,
        ...extraHookEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let lineBuffer = ''
    let settled = false

    const finish = (res: HookResult, exitCode?: number) => {
      if (settled) return
      settled = true
      cleanup()
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: stdout + stderr,
        stdout,
        stderr,
        exitCode,
        outcome:
          res.outcome === 'cancelled'
            ? 'cancelled'
            : res.outcome === 'success'
              ? 'success'
              : 'error',
      })
      resolvePromise(res)
    }

    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      finish({ outcome: 'cancelled' })
    }
    if (combinedSignal.aborted) {
      onAbort()
      return
    }
    combinedSignal.addEventListener('abort', onAbort, { once: true })

    // Pipe hook input JSON on stdin. Keep stdin open if interactive responder
    // is registered so the hook can emit a PromptRequest JSON line and receive
    // a PromptResponse line back!
    try {
      child.stdin.write(jsonInput + '\n')
      if (!interactivePromptResponder) {
        child.stdin.end()
      }
    } catch {
      // Ignore EPIPE if command exits immediately without reading stdin
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text

      if (interactivePromptResponder) {
        lineBuffer += text
        let nlIdx = lineBuffer.indexOf('\n')
        while (nlIdx !== -1) {
          const line = lineBuffer.slice(0, nlIdx).trim()
          lineBuffer = lineBuffer.slice(nlIdx + 1)
          nlIdx = lineBuffer.indexOf('\n')
          if (line.startsWith('{') && line.includes('"prompt"')) {
            try {
              const parsed = promptRequestSchema().safeParse(jsonParse(line))
              if (parsed.success) {
                void interactivePromptResponder(parsed.data).then(resp => {
                  if (resp && child.stdin.writable) {
                    child.stdin.write(jsonStringify(resp) + '\n')
                  }
                  if (child.stdin.writable) {
                    child.stdin.end()
                  }
                })
              }
            } catch {
              // ignore non-prompt JSON line
            }
          }
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', err => {
      finish({
        outcome: 'non_blocking_error',
        hookPermissionDecisionReason: `Hook execution failed: ${errorMessage(err)}`,
      })
    })

    child.on('close', code => {
      const exitCode = code ?? 1

      // Exit code 2 = explicit blocking error per Hook wire contract
      if (exitCode === 2) {
        const reason =
          stderr.trim() ||
          stdout.trim() ||
          `Hook '${hook.command}' exited with blocking code 2`
        const blockingError: HookBlockingError = {
          blockingError: reason,
          command: hook.command,
        }
        finish(
          {
            outcome: 'blocking',
            blockingError,
            ...(hookEvent === 'PreToolUse'
              ? {
                  permissionBehavior: 'deny' as const,
                  hookPermissionDecisionReason: reason,
                }
              : {}),
          },
          exitCode,
        )
        return
      }

      // Non-zero exit code other than 2 = non-blocking error
      if (exitCode !== 0) {
        finish(
          {
            outcome: 'non_blocking_error',
            hookPermissionDecisionReason:
              stderr.trim() || `Hook exited with non-zero code ${exitCode}`,
          },
          exitCode,
        )
        return
      }

      // Exit code 0: parse JSON output if present
      const parsed = parseHookOutput(stdout)
      if (parsed.json) {
        if (isAsyncHookJSONOutput(parsed.json)) {
          finish({ outcome: 'success' }, exitCode)
          return
        }
        finish(
          processHookJSONOutput(parsed.json, hookEvent, hook.command),
          exitCode,
        )
        return
      }

      // Plain text stdout on exit 0 becomes additionalContext for context-bearing events
      const plain = parsed.plainText.trim()
      if (
        plain &&
        (hookEvent === 'UserPromptSubmit' ||
          hookEvent === 'SessionStart' ||
          hookEvent === 'PostToolUse' ||
          hookEvent === 'PostToolUseFailure' ||
          hookEvent === 'Setup' ||
          hookEvent === 'SubagentStart')
      ) {
        finish(
          {
            outcome: 'success',
            additionalContext: plain,
          },
          exitCode,
        )
        return
      }

      finish({ outcome: 'success' }, exitCode)
    })
  })
}

type ExecutableHook = HookCommand | HookCallback | HookFunction

interface ResolvedHookCandidate {
  hook: ExecutableHook
  matcher?: string
  isManaged: boolean
  label: string
  pluginRoot?: string
  pluginId?: string
  skillRoot?: string
  onHookSuccess?: () => void
}

function getMatcherTargetForEvent(
  event: HookEvent,
  input: HookInput,
): string | undefined {
  switch (input.hook_event_name) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
    case 'PermissionDenied':
      return input.tool_name
    case 'SessionStart':
      return input.source
    case 'SessionEnd':
      return input.reason
    case 'PreCompact':
    case 'PostCompact':
      return input.trigger
    case 'Notification':
      return input.notification_type ?? input.message
    case 'SubagentStart':
    case 'SubagentStop':
      return input.agent_type
    case 'ConfigChange':
      return input.source
    case 'FileChanged':
      return input.file_path
    case 'Setup':
      return input.trigger
    case 'Elicitation':
    case 'ElicitationResult':
      return input.mcp_server_name
    case 'InstructionsLoaded':
      return input.memory_type
    default:
      return event
  }
}

function getToolContextFromInput(input: HookInput): {
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId: string | null
} {
  if (
    input.hook_event_name === 'PreToolUse' ||
    input.hook_event_name === 'PostToolUse' ||
    input.hook_event_name === 'PostToolUseFailure' ||
    input.hook_event_name === 'PermissionDenied'
  ) {
    return {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id,
    }
  }
  if (input.hook_event_name === 'PermissionRequest') {
    return {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: null,
    }
  }
  return { toolUseId: null }
}

function collectMatchingHooks(
  event: HookEvent,
  input: HookInput,
  toolUseContext?: ToolUseContext,
): ResolvedHookCandidate[] {
  if (shouldDisableAllHooksIncludingManaged()) {
    return []
  }

  const managedOnly = shouldAllowManagedHooksOnly()
  const isNonInteractive = Boolean(toolUseContext?.options?.isNonInteractiveSession)
  const target = getMatcherTargetForEvent(event, input)
  const { toolName, toolInput } = getToolContextFromInput(input)
  const candidates: ResolvedHookCandidate[] = []

  // 1. Settings snapshot hooks
  const snapshot = getHooksConfigFromSnapshot()
  const snapshotMatchers: HookMatcher[] = snapshot?.[event] ?? []
  const skipUntrusted = shouldSkipHookDueToTrust({
    isManaged: managedOnly,
    isNonInteractive,
  })

  if (!skipUntrusted) {
    for (const entry of snapshotMatchers) {
      if (!matchesHookMatcher(entry.matcher, target)) continue
      for (const hook of entry.hooks) {
        if (!matchesHookIfCondition(hook.if, toolName, toolInput)) continue
        candidates.push({
          hook,
          matcher: entry.matcher,
          isManaged: managedOnly,
          label:
            hook.type === 'command'
              ? hook.command
              : hook.type === 'http'
                ? hook.url
                : hook.prompt.slice(0, 60),
        })
      }
    }
  }

  // 2. Programmatic registered hooks (SDK / plugins / internal callbacks)
  const registered = getRegisteredHooks()?.[event]
  if (registered) {
    for (const matcherEntry of registered) {
      if (!matchesHookMatcher(matcherEntry.matcher, target)) continue
      const pluginRoot =
        'pluginRoot' in matcherEntry ? matcherEntry.pluginRoot : undefined
      const pluginId =
        'pluginId' in matcherEntry ? matcherEntry.pluginId : undefined
      if (pluginRoot && (managedOnly || skipUntrusted)) {
        continue
      }
      for (const rawHook of matcherEntry.hooks) {
        if (typeof rawHook === 'function') {
          const cbHook: HookCallback = {
            type: 'callback',
            callback: rawHook as unknown as HookCallback['callback'],
            timeout: 'timeout' in matcherEntry ? matcherEntry.timeout : undefined,
          }
          if (managedOnly && !cbHook.internal) continue
          candidates.push({
            hook: cbHook,
            matcher: matcherEntry.matcher,
            isManaged: Boolean(cbHook.internal),
            label: `callback:${event}`,
            ...(pluginRoot ? { pluginRoot } : {}),
            ...(pluginId ? { pluginId } : {}),
          })
        } else if (rawHook && typeof rawHook === 'object' && 'type' in rawHook) {
          const typed = rawHook as ExecutableHook
          if (managedOnly && !(typed.type === 'callback' && typed.internal)) {
            continue
          }
          if (!matchesHookIfCondition(typed.if, toolName, toolInput)) continue
          candidates.push({
            hook: typed,
            matcher: matcherEntry.matcher,
            isManaged: typed.type === 'callback' && Boolean(typed.internal),
            label: `${typed.type}:${event}`,
            ...(pluginRoot ? { pluginRoot } : {}),
            ...(pluginId ? { pluginId } : {}),
          })
        }
      }
    }
  }

  // 3. Session hooks (skills / agent frontmatter / dynamic session hooks)
  if (!managedOnly && toolUseContext?.getAppState) {
    const appState = toolUseContext.getAppState()
    const sessionRecords = getSessionHooks(appState, getSessionId(), event)
    for (const rec of sessionRecords) {
      if (!matchesHookMatcher(rec.matcher, target)) continue
      const h: RegisteredSessionHook = rec.hook
      if (!matchesHookIfCondition(h.if, toolName, toolInput)) continue
      candidates.push({
        hook: h,
        matcher: rec.matcher,
        isManaged: false,
        label:
          h.type === 'command'
            ? h.command
            : h.type === 'http'
              ? h.url
              : h.type === 'prompt' || h.type === 'agent'
                ? h.prompt.slice(0, 60)
                : `${h.type}:${event}`,
        ...(rec.skillRoot ? { skillRoot: rec.skillRoot } : {}),
        onHookSuccess: rec.onHookSuccess,
      })
    }
  }

  return candidates
}

async function executeSingleHook(
  candidate: ResolvedHookCandidate,
  event: HookEvent,
  input: HookInput,
  jsonInput: string,
  hookIndex: number,
  options?: {
    toolUseContext?: ToolUseContext
    messages?: readonly Message[]
    signal?: AbortSignal
  },
): Promise<HookResult> {
  const { hook } = candidate
  const { toolName, toolUseId } = getToolContextFromInput(input)

  // Enforce `once: true` deduplication
  if ('once' in hook && hook.once) {
    const onceKey = `${event}:${candidate.matcher ?? '*'}:${candidate.label}`
    if (executedOnceHooks.has(onceKey)) {
      return { outcome: 'success' }
    }
    executedOnceHooks.add(onceKey)
  }

  const startMs = Date.now()
  let result: HookResult

  try {
    switch (hook.type) {
      case 'command':
        result = await execCommandHook(
          hook,
          event,
          `${event}:${candidate.matcher ?? '*'}`,
          jsonInput,
          toolName,
          options?.signal,
          {
            pluginRoot: candidate.pluginRoot,
            pluginId: candidate.pluginId,
            skillRoot: candidate.skillRoot,
          },
        )
        break

      case 'http': {
        const httpRes = await execHttpHook(hook, event, jsonInput, options?.signal)
        if (httpRes.aborted) {
          result = { outcome: 'cancelled' }
        } else if (!httpRes.ok) {
          result = {
            outcome: 'non_blocking_error',
            hookPermissionDecisionReason:
              httpRes.error ?? `HTTP hook failed with status ${httpRes.statusCode}`,
          }
        } else {
          const parsed = parseHookOutput(httpRes.body)
          if (parsed.json && !isAsyncHookJSONOutput(parsed.json)) {
            result = processHookJSONOutput(parsed.json, event, hook.url)
          } else {
            result = { outcome: 'success' }
          }
        }
        break
      }

      case 'prompt':
        result = await execPromptHook(hook, event, jsonInput, options?.signal)
        break

      case 'agent':
        result = await execAgentHook(
          hook,
          event,
          jsonInput,
          options?.messages ?? options?.toolUseContext?.messages ?? [],
          options?.signal,
        )
        break

      case 'callback': {
        const cbCtx = options?.toolUseContext?.getAppState
          ? { getAppState: options.toolUseContext.getAppState }
          : undefined
        const out = await hook.callback(
          input,
          toolUseId,
          options?.signal,
          hookIndex,
          cbCtx,
        )
        if (out && !isAsyncHookJSONOutput(out)) {
          result = processHookJSONOutput(out, event, candidate.label)
        } else {
          result = { outcome: 'success' }
        }
        break
      }

      case 'function': {
        const passed = await hook.callback(
          options?.messages ?? options?.toolUseContext?.messages ?? [],
          input,
        )
        if (passed) {
          result = { outcome: 'success' }
        } else {
          result = {
            outcome: 'blocking',
            blockingError: {
              blockingError: hook.errorMessage,
              command: hook.id ?? candidate.label,
            },
            ...(event === 'PreToolUse'
              ? {
                  permissionBehavior: 'deny' as const,
                  hookPermissionDecisionReason: hook.errorMessage,
                }
              : {}),
          }
        }
        break
      }
    }
  } catch (error) {
    result = {
      outcome: 'non_blocking_error',
      hookPermissionDecisionReason: `Hook error: ${errorMessage(error)}`,
    }
  }

  addToTurnHookDuration(Date.now() - startMs)
  if (result.outcome === 'success') {
    candidate.onHookSuccess?.()
  }
  return result
}

function mergeHookPermissionBehavior(
  current: AggregatedHookResult['permissionBehavior'],
  incoming: HookResult['permissionBehavior'],
): AggregatedHookResult['permissionBehavior'] {
  if (!incoming || incoming === 'passthrough') return current
  if (current === 'deny' || incoming === 'deny') return 'deny'
  if (current === 'ask' || incoming === 'ask') return 'ask'
  return 'allow'
}

/**
 * Core 27-event lifecycle hook dispatcher. Runs all matching hooks and
 * aggregates decisions using strict `deny > ask > allow` precedence.
 */
export async function executeHooks(
  event: HookEvent,
  input: HookInput,
  options?: {
    toolUseContext?: ToolUseContext
    messages?: readonly Message[]
    signal?: AbortSignal
  },
): Promise<AggregatedHookResult> {
  const candidates = collectMatchingHooks(event, input, options?.toolUseContext)
  const aggregated: AggregatedHookResult = {
    messages: [],
    blockingErrors: [],
    preventContinuation: false,
    additionalContexts: [],
    watchPaths: [],
  }

  if (candidates.length === 0) {
    return aggregated
  }

  const jsonInput = jsonStringify(input)
  logForDebugging(`Hooks: Executing ${candidates.length} hook(s) for ${event}`)

  const results = await Promise.all(
    candidates.map((cand, idx) =>
      executeSingleHook(cand, event, input, jsonInput, idx, options),
    ),
  )

  for (const res of results) {
    if (res.message) aggregated.messages.push(res.message)
    if (res.systemMessage) aggregated.messages.push(res.systemMessage)
    if (res.blockingError) aggregated.blockingErrors.push(res.blockingError)
    if (res.preventContinuation) {
      aggregated.preventContinuation = true
      if (res.stopReason) aggregated.stopReason = res.stopReason
    }
    if (res.additionalContext) {
      aggregated.additionalContexts.push(res.additionalContext)
    }
    if (res.initialUserMessage) {
      aggregated.initialUserMessage = res.initialUserMessage
    }
    if (res.updatedInput) {
      aggregated.updatedInput = {
        ...(aggregated.updatedInput ?? {}),
        ...res.updatedInput,
      }
    }
    if (res.updatedMCPToolOutput !== undefined) {
      aggregated.updatedMCPToolOutput = res.updatedMCPToolOutput
    }
    if (res.permissionRequestResult && !aggregated.permissionRequestResult) {
      aggregated.permissionRequestResult = res.permissionRequestResult
    }
    if (res.retry !== undefined) {
      aggregated.retry = aggregated.retry || res.retry
    }
    if (res.watchPaths?.length) {
      aggregated.watchPaths.push(...res.watchPaths)
    }
    if (res.worktreePath) {
      aggregated.worktreePath = res.worktreePath
    }

    const prevBehavior = aggregated.permissionBehavior
    aggregated.permissionBehavior = mergeHookPermissionBehavior(
      prevBehavior,
      res.permissionBehavior,
    )
    if (
      res.hookPermissionDecisionReason &&
      (aggregated.permissionBehavior === res.permissionBehavior ||
        !aggregated.hookPermissionDecisionReason)
    ) {
      aggregated.hookPermissionDecisionReason = res.hookPermissionDecisionReason
    }
  }

  return aggregated
}

// ============================================================================
// Typed Event Dispatchers for All 27 Lifecycle Events
// ============================================================================

export async function executePreToolUseHooks(params: {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
  signal?: AbortSignal
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'PreToolUse',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'PreToolUse',
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_use_id: params.toolUseId,
    },
    { toolUseContext: params.toolUseContext, signal: params.signal },
  )
}

export async function executePostToolUseHooks(params: {
  toolName: string
  toolInput: Record<string, unknown>
  toolResponse: unknown
  toolUseId: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
  signal?: AbortSignal
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'PostToolUse',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'PostToolUse',
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_response: params.toolResponse,
      tool_use_id: params.toolUseId,
    },
    { toolUseContext: params.toolUseContext, signal: params.signal },
  )
}

export async function executePostToolUseFailureHooks(params: {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  error: string
  isInterrupt?: boolean
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
  signal?: AbortSignal
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'PostToolUseFailure',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'PostToolUseFailure',
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_use_id: params.toolUseId,
      error: params.error,
      ...(params.isInterrupt !== undefined
        ? { is_interrupt: params.isInterrupt }
        : {}),
    },
    { toolUseContext: params.toolUseContext, signal: params.signal },
  )
}

export async function executePermissionRequestHooks(params: {
  toolName: string
  toolInput: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
  signal?: AbortSignal
}): Promise<{
  decision?: PermissionRequestResult
  aggregated: AggregatedHookResult
}> {
  const aggregated = await executeHooks(
    'PermissionRequest',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'PermissionRequest',
      tool_name: params.toolName,
      tool_input: params.toolInput,
      ...(params.suggestions?.length
        ? { permission_suggestions: params.suggestions }
        : {}),
    },
    { toolUseContext: params.toolUseContext, signal: params.signal },
  )
  return {
    decision: aggregated.permissionRequestResult,
    aggregated,
  }
}

export async function executePermissionDeniedHooks(params: {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  reason: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
  signal?: AbortSignal
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'PermissionDenied',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'PermissionDenied',
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_use_id: params.toolUseId,
      reason: params.reason,
    },
    { toolUseContext: params.toolUseContext, signal: params.signal },
  )
}

export async function executeUserPromptSubmitHooks(params: {
  prompt: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
  signal?: AbortSignal
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'UserPromptSubmit',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'UserPromptSubmit',
      prompt: params.prompt,
    },
    { toolUseContext: params.toolUseContext, signal: params.signal },
  )
}

export async function executeStopHooks(params: {
  stopHookActive: boolean
  lastAssistantMessage?: string
  permissionMode?: PermissionMode
  agentId?: string
  agentType?: string
  toolUseContext?: ToolUseContext
  messages?: readonly Message[]
  signal?: AbortSignal
}): Promise<AggregatedHookResult> {
  if (params.agentId) {
    return executeHooks(
      'SubagentStop',
      {
        ...createBaseHookInput(params.permissionMode, {
          agentId: params.agentId,
          agentType: params.agentType,
        }),
        hook_event_name: 'SubagentStop',
        stop_hook_active: params.stopHookActive,
        agent_id: params.agentId,
        ...(params.agentType ? { agent_type: params.agentType } : {}),
        ...(params.lastAssistantMessage
          ? { last_assistant_message: params.lastAssistantMessage }
          : {}),
      },
      {
        toolUseContext: params.toolUseContext,
        messages: params.messages,
        signal: params.signal,
      },
    )
  }

  return executeHooks(
    'Stop',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'Stop',
      stop_hook_active: params.stopHookActive,
      ...(params.lastAssistantMessage
        ? { last_assistant_message: params.lastAssistantMessage }
        : {}),
    },
    {
      toolUseContext: params.toolUseContext,
      messages: params.messages,
      signal: params.signal,
    },
  )
}

export async function executeStopFailureHooks(params: {
  error: string
  errorDetails?: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'StopFailure',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'StopFailure',
      error: params.error,
      ...(params.errorDetails ? { error_details: params.errorDetails } : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeSessionStartHooks(params: {
  source: 'startup' | 'resume' | 'clear' | 'compact'
  model?: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'SessionStart',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'SessionStart',
      source: params.source,
      ...(params.model ? { model: params.model } : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeSessionEndHooks(params: {
  reason: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'SessionEnd',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'SessionEnd',
      reason: params.reason,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeCwdChangedHooks(params: {
  oldCwd: string
  newCwd: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'CwdChanged',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'CwdChanged',
      old_cwd: params.oldCwd,
      new_cwd: params.newCwd,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeFileChangedHooks(params: {
  filePath: string
  event: 'change' | 'add' | 'unlink'
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'FileChanged',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'FileChanged',
      file_path: params.filePath,
      event: params.event,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeNotificationHooks(params: {
  message: string
  title?: string
  notificationType?: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'Notification',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'Notification',
      message: params.message,
      ...(params.title ? { title: params.title } : {}),
      ...(params.notificationType
        ? { notification_type: params.notificationType }
        : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeSubagentStartHooks(params: {
  agentId: string
  agentType: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'SubagentStart',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'SubagentStart',
      agent_id: params.agentId,
      agent_type: params.agentType,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executePreCompactHooks(params: {
  trigger: 'manual' | 'auto'
  customInstructions?: string | null
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'PreCompact',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'PreCompact',
      trigger: params.trigger,
      custom_instructions: params.customInstructions ?? null,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executePostCompactHooks(params: {
  trigger: 'manual' | 'auto'
  compactSummary: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'PostCompact',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'PostCompact',
      trigger: params.trigger,
      compact_summary: params.compactSummary,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeSetupHooks(params: {
  trigger: 'init' | 'maintenance'
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'Setup',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'Setup',
      trigger: params.trigger,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeTeammateIdleHooks(params: {
  teammateName: string
  teamName: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'TeammateIdle',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'TeammateIdle',
      teammate_name: params.teammateName,
      team_name: params.teamName,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeTaskCreatedHooks(params: {
  taskId: string
  taskSubject: string
  taskDescription?: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'TaskCreated',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'TaskCreated',
      task_id: params.taskId,
      task_subject: params.taskSubject,
      ...(params.taskDescription
        ? { task_description: params.taskDescription }
        : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeTaskCompletedHooks(params: {
  taskId: string
  taskSubject: string
  taskDescription?: string
  teammateName?: string
  teamName?: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'TaskCompleted',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'TaskCompleted',
      task_id: params.taskId,
      task_subject: params.taskSubject,
      ...(params.taskDescription
        ? { task_description: params.taskDescription }
        : {}),
      ...(params.teammateName ? { teammate_name: params.teammateName } : {}),
      ...(params.teamName ? { team_name: params.teamName } : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeElicitationHooks(params: {
  mcpServerName: string
  message: string
  requestedSchema?: Record<string, unknown>
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'Elicitation',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'Elicitation',
      mcp_server_name: params.mcpServerName,
      message: params.message,
      ...(params.requestedSchema
        ? { requested_schema: params.requestedSchema }
        : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeElicitationResultHooks(params: {
  mcpServerName: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'ElicitationResult',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'ElicitationResult',
      mcp_server_name: params.mcpServerName,
      action: params.action,
      ...(params.content ? { content: params.content } : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeConfigChangeHooks(params: {
  source: string
  filePath?: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'ConfigChange',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'ConfigChange',
      source: params.source,
      ...(params.filePath ? { file_path: params.filePath } : {}),
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeWorktreeCreateHooks(params: {
  name: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'WorktreeCreate',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'WorktreeCreate',
      name: params.name,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeWorktreeRemoveHooks(params: {
  worktreePath: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'WorktreeRemove',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'WorktreeRemove',
      worktree_path: params.worktreePath,
    },
    { toolUseContext: params.toolUseContext },
  )
}

export async function executeInstructionsLoadedHooks(params: {
  filePath: string
  memoryType: string
  loadReason: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
}): Promise<AggregatedHookResult> {
  return executeHooks(
    'InstructionsLoaded',
    {
      ...createBaseHookInput(params.permissionMode),
      hook_event_name: 'InstructionsLoaded',
      file_path: params.filePath,
      memory_type: params.memoryType,
      load_reason: params.loadReason,
    },
    { toolUseContext: params.toolUseContext },
  )
}
