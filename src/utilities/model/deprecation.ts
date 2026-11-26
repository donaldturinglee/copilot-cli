/**
 * Model deprecation schedule warnings per API provider.
 */

import { type ApiProvider, getApiProvider } from './providers.js'

const DEPRECATION_SCHEDULE: Record<string, Record<ApiProvider, string | null>> =
  {
    'claude-3-opus': {
      firstParty: 'January 5, 2026',
      vertex: 'January 5, 2026',
      foundry: 'January 5, 2026',
      bedrock: 'January 15, 2026',
    },
    'claude-3-7-sonnet': {
      firstParty: 'February 19, 2026',
      foundry: 'February 19, 2026',
      bedrock: 'April 28, 2026',
      vertex: 'May 11, 2026',
    },
    'claude-3-5-haiku': {
      firstParty: 'February 19, 2026',
      bedrock: null,
      vertex: null,
      foundry: null,
    },
  }

/**
 * Returns a deprecation warning message if `modelId` is scheduled for retirement
 * on the active API provider, or `null` otherwise.
 */
export function getModelDeprecationWarning(modelId: string): string | null {
  const lower = modelId.toLowerCase()
  const provider = getApiProvider()
  for (const [pattern, dates] of Object.entries(DEPRECATION_SCHEDULE)) {
    if (lower.includes(pattern)) {
      const date = dates[provider]
      if (date) {
        return `Model ${modelId} is deprecated (retirement date: ${date}). Consider switching to a newer model with /model.`
      }
    }
  }
  return null
}
