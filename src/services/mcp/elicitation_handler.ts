/**
 * MCP Elicitation request handler integrating `Elicitation` / `ElicitationResult`
 * lifecycle hooks and queuing interactive form/URL prompts in `AppState`.
 */

import type {
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../state/app_state_store.js'
import type { ElicitationRequestEvent } from '../../types/forward.js'
import { randomUUID } from '../../utilities/crypto.js'
import {
  executeElicitationHooks,
  executeElicitationResultHooks,
} from '../../utilities/hooks.js'

export interface CreateElicitationHandlerOptions {
  serverName: string
  getAppState?: () => AppState
  setAppState?: (updater: (prev: AppState) => AppState) => void
  signal?: AbortSignal
}

/**
 * Creates a server-bound MCP `elicitInput` handler that runs pre/post hooks and
 * enqueues interactive UI prompts into `AppState.elicitation.queue`.
 */
export function createElicitationHandler(
  options: CreateElicitationHandlerOptions,
): (params: ElicitRequestParams) => Promise<ElicitResult> {
  return async (params: ElicitRequestParams): Promise<ElicitResult> => {
    const requestId =
      'elicitationId' in params && typeof params.elicitationId === 'string'
        ? params.elicitationId
        : randomUUID()
    const mode: 'form' | 'url' =
      'mode' in params && params.mode === 'url' ? 'url' : 'form'
    const requestedSchema =
      'requestedSchema' in params &&
      params.requestedSchema &&
      typeof params.requestedSchema === 'object'
        ? (params.requestedSchema as Record<string, unknown>)
        : undefined
    const url =
      'url' in params && typeof params.url === 'string' ? params.url : undefined

    try {
      const preHook = await executeElicitationHooks({
        mcpServerName: options.serverName,
        message: params.message,
        requestedSchema,
      })
      if (
        preHook.blockingErrors.length > 0 ||
        preHook.permissionBehavior === 'deny'
      ) {
        return { action: 'decline' }
      }
      if (preHook.permissionBehavior === 'allow' && preHook.updatedInput) {
        return {
          action: 'accept',
          content: preHook.updatedInput as ElicitResult['content'],
        }
      }
    } catch {
      // Proceed to interactive queue if hook execution fails
    }

    if (!options.setAppState) {
      return { action: 'cancel' }
    }

    const response = await new Promise<ElicitResult>(resolve => {
      const event: ElicitationRequestEvent = {
        serverName: options.serverName,
        requestId,
        message: params.message,
        mode,
        url,
        requestedSchema,
        resolve: raw => {
          const res = raw as ElicitResult | undefined
          resolve(res ?? { action: 'cancel' })
        },
      }
      options.setAppState!(prev => ({
        ...prev,
        elicitation: {
          queue: [...prev.elicitation.queue, event],
        },
      }))
    })

    try {
      const postHook = await executeElicitationResultHooks({
        mcpServerName: options.serverName,
        action: response.action,
        content:
          'content' in response && response.content
            ? (response.content as Record<string, unknown>)
            : undefined,
      })
      if (
        postHook.blockingErrors.length > 0 ||
        postHook.permissionBehavior === 'deny'
      ) {
        return { action: 'decline' }
      }
    } catch {
      // Ignore post-hook errors
    }

    return response
  }
}

/**
 * Resolves and dequeues a waiting URL-mode elicitation item when the server
 * sends `notifications/elicitation/complete`.
 */
export function completeElicitationById(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  elicitationId: string,
): void {
  setAppState(prev => {
    const match = prev.elicitation.queue.find(
      item => item.requestId === elicitationId,
    )
    if (!match) {
      return prev
    }
    match.resolve?.({ action: 'accept', content: {} })
    return {
      ...prev,
      elicitation: {
        queue: prev.elicitation.queue.filter(
          item => item.requestId !== elicitationId,
        ),
      },
    }
  })
}
