/**
 * Single tool-use execution pipeline (`runToolUse`):
 * 1. Tool resolution by canonical name or alias (with deferred-tool hint)
 * 2. Input cloning + `backfillObservableInput()` (never mutates original block)
 * 3. Zod schema validation (`formatZodValidationError`) + `tool.validateInput()`
 * 4. `PreToolUse` hooks (`deny > ask > allow`, optional `updatedInput`)
 * 5. Permission gate (`canUseTool`)
 * 6. `tool.call()` with real-time `Stream` progress forwarding
 * 7. `mapToolResultToToolResultBlockParam()` + `processPreMappedToolResultBlock()`
 * 8. `PostToolUse` / `PostToolUseFailure` hooks and telemetry
 */

import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { addToToolDuration } from '../../bootstrap/state.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../constants/tools.js'
import type { ToolRunUpdate } from '../../query/deps.js'
import {
  type AnyTool,
  findToolByName,
  type ToolUseContext,
} from '../../tool.js'
import type { CanUseToolFn } from '../../types/forward.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import type { ToolProgressData } from '../../types/tools.js'
import { createAttachmentMessage } from '../../utilities/attachments.js'
import { isAbortError, ShellError } from '../../utilities/errors.js'
import {
  createProgressMessage,
  createUserMessage,
} from '../../utilities/messages.js'
import { checkRuleBasedPermissions } from '../../utilities/permissions/permissions.js'
import { clone } from '../../utilities/slow_operations.js'
import { Stream } from '../../utilities/stream.js'
import {
  formatError,
  formatZodValidationError,
} from '../../utilities/tool_errors.js'
import { processPreMappedToolResultBlock } from '../../utilities/tool_result_storage.js'
import {
  runPermissionDeniedHooks,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from './tool_hooks.js'

export interface ToolExecutionOutcome extends ToolRunUpdate {
  isError?: boolean
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}

export function classifyToolError(error: unknown): {
  message: string
  isAbort: boolean
} {
  if (isAbortError(error)) {
    return {
      message: 'Tool execution was aborted.',
      isAbort: true,
    }
  }
  if (error instanceof ShellError) {
    const parts: string[] = []
    if (error.stdout.trim()) parts.push(error.stdout.trimEnd())
    if (error.stderr.trim()) parts.push(error.stderr.trimEnd())
    if (error.interrupted) {
      parts.push('Command was interrupted.')
    }
    const detail = parts.join('\n') || `Exit code ${error.code}`
    return {
      message: `Exit code ${error.code}\n${detail}`,
      isAbort: error.interrupted,
    }
  }
  return {
    message: formatError(error),
    isAbort: false,
  }
}

export function buildSchemaNotSentHint(toolName: string): string {
  return `Tool "${toolName}" is deferred and must be loaded via ${TOOL_SEARCH_TOOL_NAME} before calling it.`
}

function createToolErrorUserMessage(
  toolUseId: string,
  errorText: string,
  assistantUuid: AssistantMessage['uuid'],
): UserMessage {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `<tool_use_error>${errorText}</tool_use_error>`,
        is_error: true,
      },
    ],
    toolUseResult: errorText,
    sourceToolAssistantUuid: assistantUuid,
  })
}

/**
 * Executes a single `tool_use` block, yielding live `progress` messages,
 * the final `user` `tool_result` message, any `newMessages` (e.g.
 * `structured_output` or hook attachments), and an optional `contextModifier`.
 */
export async function* runToolUse(
  toolUse: BetaToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<ToolExecutionOutcome, void> {
  const startTime = Date.now()
  const tools = toolUseContext.options?.tools ?? []
  const tool: AnyTool | undefined = findToolByName(tools, toolUse.name)

  if (!tool) {
    const msg = `Error: No such tool available: ${toolUse.name}`
    yield {
      message: createToolErrorUserMessage(
        toolUse.id,
        msg,
        assistantMessage.uuid,
      ),
      isError: true,
    }
    return
  }

  // Clone raw input so `backfillObservableInput` NEVER mutates assistantMessage (Prompt Cache invariant)
  const rawInputObj: Record<string, unknown> =
    toolUse.input && typeof toolUse.input === 'object' && !Array.isArray(toolUse.input)
      ? clone(toolUse.input as Record<string, unknown>)
      : {}

  if (tool.backfillObservableInput) {
    try {
      tool.backfillObservableInput(rawInputObj)
    } catch {
      // Best-effort backfill; Zod validation below catches invalid inputs
    }
  }

  // 1. Zod schema validation
  const zodParsed = tool.inputSchema.safeParse(rawInputObj)
  if (!zodParsed.success) {
    const errText = formatZodValidationError(tool.name, zodParsed.error)
    yield {
      message: createToolErrorUserMessage(
        toolUse.id,
        errText,
        assistantMessage.uuid,
      ),
      isError: true,
    }
    return
  }

  let validatedInput = zodParsed.data as Record<string, unknown>

  // 2. Semantic tool validation (`validateInput`)
  if (tool.validateInput) {
    const validation = await tool.validateInput(validatedInput, toolUseContext)
    if (!validation.result) {
      yield {
        message: createToolErrorUserMessage(
          toolUse.id,
          validation.message,
          assistantMessage.uuid,
        ),
        isError: true,
      }
      return
    }
  }

  // 3. PreToolUse hooks
  const preHook = await runPreToolUseHooks({
    tool,
    input: validatedInput,
    toolUseId: toolUse.id,
    context: toolUseContext,
  })
  for (const hookMsg of preHook.messages) {
    yield { message: hookMsg }
  }
  if (preHook.additionalContext.length > 0) {
    yield {
      message: createAttachmentMessage({
        type: 'hook_additional_context',
        content: preHook.additionalContext,
      }),
    }
  }
  if (preHook.preventContinuation) {
    yield {
      message: createAttachmentMessage({
        type: 'hook_stopped_continuation',
        toolUseId: toolUse.id,
      }),
    }
  }
  if (preHook.decision === 'deny') {
    const reason = preHook.reason || `Tool ${tool.name} denied by PreToolUse hook.`
    const deniedHooks = await runPermissionDeniedHooks({
      tool,
      input: validatedInput,
      reason,
      toolUseId: toolUse.id,
      context: toolUseContext,
    })
    for (const msg of deniedHooks.messages) {
      yield { message: msg }
    }
    yield {
      message: createToolErrorUserMessage(
        toolUse.id,
        reason,
        assistantMessage.uuid,
      ),
      isError: true,
    }
    return
  }

  let inputWasUpdatedByHook = false
  if (preHook.updatedInput) {
    const mergedInput = {
      ...validatedInput,
      ...preHook.updatedInput,
    }
    const reParsed = tool.inputSchema.safeParse(mergedInput)
    if (!reParsed.success) {
      const errText = formatZodValidationError(tool.name, reParsed.error)
      yield {
        message: createToolErrorUserMessage(
          toolUse.id,
          errText,
          assistantMessage.uuid,
        ),
        isError: true,
      }
      return
    }
    validatedInput = reParsed.data as Record<string, unknown>
    inputWasUpdatedByHook = true
  }

  // SECURITY INVARIANT: A `PreToolUse` hook returning `updatedInput` or
  // `permissionDecision: 'allow'` MUST NEVER bypass explicit `deny` rules or
  // sensitive-path `safetyCheck`! Always re-evaluate rule-based permissions.
  if (inputWasUpdatedByHook || preHook.decision === 'allow') {
    const ruleRecheck = await checkRuleBasedPermissions(
      tool,
      validatedInput,
      toolUseContext,
    )
    if (ruleRecheck.behavior === 'deny') {
      const denyReason =
        ruleRecheck.message ||
        `Tool ${tool.name} denied by security rule after PreToolUse hook.`
      const deniedHooks = await runPermissionDeniedHooks({
        tool,
        input: validatedInput,
        reason: denyReason,
        toolUseId: toolUse.id,
        context: toolUseContext,
      })
      for (const msg of deniedHooks.messages) {
        yield { message: msg }
      }
      yield {
        message: createToolErrorUserMessage(
          toolUse.id,
          denyReason,
          assistantMessage.uuid,
        ),
        isError: true,
      }
      return
    }
    if (
      ruleRecheck.behavior === 'ask' &&
      ruleRecheck.decisionReason?.type === 'safetyCheck'
    ) {
      const safetyReason = ruleRecheck.message
      const deniedHooks = await runPermissionDeniedHooks({
        tool,
        input: validatedInput,
        reason: safetyReason,
        toolUseId: toolUse.id,
        context: toolUseContext,
      })
      for (const msg of deniedHooks.messages) {
        yield { message: msg }
      }
      yield {
        message: createToolErrorUserMessage(
          toolUse.id,
          safetyReason,
          assistantMessage.uuid,
        ),
        isError: true,
      }
      return
    }
  }

  // 4. Permission gate (`canUseTool`)
  // If a `PreToolUse` hook explicitly returned `allow` AND passed the rule/safetyCheck
  // re-evaluation above (and is not explicitly `ask`), honor the hook allow decision.
  let permissionResult: Awaited<ReturnType<CanUseToolFn>>
  if (preHook.decision === 'allow') {
    permissionResult = {
      behavior: 'allow',
      updatedInput: validatedInput,
      decisionReason: {
        type: 'hook',
        hookName: 'PreToolUse',
        reason: preHook.reason,
      },
    }
  } else {
    permissionResult = await canUseTool(
      tool,
      validatedInput,
      toolUseContext,
      assistantMessage,
      toolUse.id,
    )
  }

  if (permissionResult.behavior !== 'allow') {
    const denyReason =
      'message' in permissionResult && permissionResult.message
        ? permissionResult.message
        : `Permission denied for tool ${tool.name}.`
    const deniedHooks = await runPermissionDeniedHooks({
      tool,
      input: validatedInput,
      reason: denyReason,
      toolUseId: toolUse.id,
      context: toolUseContext,
    })
    for (const msg of deniedHooks.messages) {
      yield { message: msg }
    }
    yield {
      message: createToolErrorUserMessage(
        toolUse.id,
        denyReason,
        assistantMessage.uuid,
      ),
      isError: true,
    }
    return
  }

  const finalInput = (permissionResult.updatedInput ?? validatedInput) as Record<
    string,
    unknown
  >

  // 5. Execute tool with live progress streaming
  const progressStream = new Stream<Message>()
  let callResult: Awaited<ReturnType<AnyTool['call']>> | undefined
  let callError: unknown

  const callPromise = (async () => {
    try {
      callResult = await tool.call(
        finalInput,
        toolUseContext,
        canUseTool,
        assistantMessage,
        progress => {
          progressStream.enqueue(
            createProgressMessage<ToolProgressData>({
              data: progress.data,
              toolUseId: progress.toolUseId,
              parentToolUseId: toolUse.id,
            }),
          )
        },
      )
    } catch (error) {
      callError = error
    } finally {
      progressStream.done()
    }
  })()

  for await (const progressMsg of progressStream) {
    yield { message: progressMsg }
  }
  await callPromise

  addToToolDuration(Date.now() - startTime)

  if (callError !== undefined) {
    const classified = classifyToolError(callError)
    const failureHooks = await runPostToolUseFailureHooks({
      tool,
      input: finalInput,
      error: classified.message,
      toolUseId: toolUse.id,
      context: toolUseContext,
    })
    for (const hookMsg of failureHooks.messages) {
      yield { message: hookMsg }
    }
    if (failureHooks.additionalContext.length > 0) {
      yield {
        message: createAttachmentMessage({
          type: 'hook_additional_context',
          content: failureHooks.additionalContext,
        }),
      }
    }
    yield {
      message: createToolErrorUserMessage(
        toolUse.id,
        classified.message,
        assistantMessage.uuid,
      ),
      isError: true,
    }
    return
  }

  const result = callResult!
  const rawBlock = tool.mapToolResultToToolResultBlockParam(
    result.data,
    toolUse.id,
  )
  const processedBlock = processPreMappedToolResultBlock(rawBlock, tool)

  const userResultMessage = createUserMessage({
    content: [processedBlock],
    toolUseResult: result.data,
    sourceToolAssistantUuid: assistantMessage.uuid,
    ...(result.mcpMeta ? { mcpMeta: result.mcpMeta } : {}),
  })

  yield {
    message: userResultMessage,
    isError: processedBlock.is_error === true,
    ...(result.contextModifier
      ? { contextModifier: result.contextModifier }
      : {}),
  }

  if (result.newMessages) {
    for (const extraMsg of result.newMessages) {
      yield { message: extraMsg }
    }
  }

  // 6. PostToolUse hooks
  const postHook = await runPostToolUseHooks({
    tool,
    input: finalInput,
    output: result.data,
    toolUseId: toolUse.id,
    context: toolUseContext,
  })
  for (const hookMsg of postHook.messages) {
    yield { message: hookMsg }
  }
  if (postHook.additionalContext.length > 0) {
    yield {
      message: createAttachmentMessage({
        type: 'hook_additional_context',
        content: postHook.additionalContext,
      }),
    }
  }
  if (postHook.preventContinuation) {
    yield {
      message: createAttachmentMessage({
        type: 'hook_stopped_continuation',
        toolUseId: toolUse.id,
      }),
    }
  }
}
