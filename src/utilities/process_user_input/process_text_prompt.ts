import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import type { ToolUseContext } from '../../tool.js'
import type { UserMessage } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { randomUUID } from '../crypto.js'
import { executeUserPromptSubmitHooks } from '../hooks.js'
import { resolveImageBlocks } from '../image_paste.js'
import { expandPastedText } from '../paste_store.js'

export type ProcessedTextPrompt =
  | {
      blocked: true
      reason: string
    }
  | {
      blocked: false
      expandedText: string
      userMessage: UserMessage
      additionalContext: string[]
      imagePasteIds: number[]
    }

/**
 * Expand folded `[Pasted text #N +X lines]` & `[Image #N]` chips, execute
 * `UserPromptSubmit` lifecycle hooks, and produce a model-ready `UserMessage`.
 */
export async function processTextPrompt(params: {
  rawInput: string
  permissionMode?: PermissionMode
  toolUseContext?: ToolUseContext
  signal?: AbortSignal
  skipHooks?: boolean
}): Promise<ProcessedTextPrompt> {
  const expandedText = expandPastedText(params.rawInput)
  const { imageIds, blocks: imageBlocks } = resolveImageBlocks(expandedText)

  let additionalContext: string[] = []
  if (!params.skipHooks) {
    try {
      const hookResult = await executeUserPromptSubmitHooks({
        prompt: expandedText,
        permissionMode: params.permissionMode,
        toolUseContext: params.toolUseContext,
        signal: params.signal,
      })
      if (hookResult.blockingErrors.length > 0) {
        return {
          blocked: true,
          reason: hookResult.blockingErrors
            .map(e => e.blockingError)
            .join('; '),
        }
      }
      if (hookResult.preventContinuation) {
        return {
          blocked: true,
          reason: hookResult.stopReason ?? 'Blocked by UserPromptSubmit hook',
        }
      }
      additionalContext = hookResult.additionalContexts
    } catch {
      // Non-fatal hook runner error: allow prompt to proceed
    }
  }

  const finalPromptText =
    additionalContext.length > 0
      ? `${expandedText}\n\n<system-reminder>\n${additionalContext.join('\n')}\n</system-reminder>`
      : expandedText

  const content: string | ContentBlockParam[] =
    imageBlocks.length > 0
      ? [{ type: 'text', text: finalPromptText }, ...imageBlocks]
      : finalPromptText

  const userMessage: UserMessage = {
    type: 'user',
    uuid: randomUUID() as UUID,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content,
    },
    ...(imageIds.length > 0 ? { imagePasteIds: imageIds } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
  }

  return {
    blocked: false,
    expandedText,
    userMessage,
    additionalContext,
    imagePasteIds: imageIds,
  }
}
