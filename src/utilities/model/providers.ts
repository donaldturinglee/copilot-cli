/**
 * LLM API provider detection (`firstParty`, `bedrock`, `vertex`, `foundry`).
 */

import { isEnvTruthy } from '../env_utils.js'

export type ApiProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

/**
 * Resolves the active API provider from environment flags.
 */
export function getApiProvider(): ApiProvider {
  if (isEnvTruthy(process.env.COPILOT_CLI_USE_BEDROCK)) {
    return 'bedrock'
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_USE_VERTEX)) {
    return 'vertex'
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_USE_FOUNDRY)) {
    return 'foundry'
  }
  return 'firstParty'
}

/**
 * Returns true if requests target Anthropic's first-party API host (default or
 * explicit `api.anthropic.com`).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host.toLowerCase()
    if (host === 'api.anthropic.com') {
      return true
    }
    if (
      process.env.USER_TYPE === 'ant' &&
      host === 'api-staging.anthropic.com'
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}
