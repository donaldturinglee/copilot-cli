/**
 * Validates user-supplied model names against aliases, allowlists, cache, and
 * a minimal 1-token `sideQuery` probe with 3P fallback model hints.
 */

import { APIError } from '@anthropic-ai/sdk'
import { sideQuery } from '../side_query.js'
import { isModelAlias } from './aliases.js'
import { parseUserSpecifiedModel } from './model.js'
import { isModelAllowed } from './model_allowlist.js'
import { getModelStrings } from './model_strings.js'
import { getApiProvider } from './providers.js'

export interface ModelValidationResult {
  valid: boolean
  error?: string
  suggestion?: string
}

const validModelCache = new Set<string>()

/**
 * Clears cached validated model names (for tests).
 */
export function clearValidModelCacheForTesting(): void {
  validModelCache.clear()
}

function get3pSuggestion(model: string): string | undefined {
  if (getApiProvider() === 'firstParty') {
    return undefined
  }
  const lower = model.toLowerCase()
  const strings = getModelStrings()
  if (lower.includes('opus-4-6')) return strings.opus41
  if (lower.includes('sonnet-4-6')) return strings.sonnet45
  if (lower.includes('sonnet-4-5')) return strings.sonnet40
  return undefined
}

/**
 * Validates whether `model` is allowed and reachable via the configured provider.
 */
export async function validateModel(
  model: string,
  signal?: AbortSignal,
): Promise<ModelValidationResult> {
  const trimmed = model.trim()
  if (!trimmed) {
    return { valid: false, error: 'Model name cannot be empty.' }
  }
  if (!isModelAllowed(trimmed)) {
    return {
      valid: false,
      error: `Model "${trimmed}" is not permitted by your organization's availableModels setting.`,
    }
  }
  if (
    isModelAlias(trimmed) ||
    trimmed === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  ) {
    return { valid: true }
  }

  const resolved = parseUserSpecifiedModel(trimmed)
  if (validModelCache.has(resolved)) {
    return { valid: true }
  }

  try {
    await sideQuery({
      model: resolved,
      maxTokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      signal,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })
    validModelCache.add(resolved)
    return { valid: true }
  } catch (error) {
    if (error instanceof APIError && error.status === 404) {
      const suggestion = get3pSuggestion(resolved)
      return {
        valid: false,
        error: `Model "${trimmed}" was not found on the current provider.`,
        ...(suggestion ? { suggestion } : {}),
      }
    }
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
