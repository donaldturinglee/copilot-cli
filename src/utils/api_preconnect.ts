import { isEnvTruthy } from './env_utils.js'

const DEFAULT_BASE_API_URL = 'https://api.anthropic.com'
const PRECONNECT_TIMEOUT_MS = 10_000

let fired = false

/**
 * Initiates a one-shot non-blocking HEAD preconnect to the Anthropic API
 * to warm DNS and TLS connections early in startup.
 */
export function preconnectAnthropicApi(): void {
  if (fired) return
  fired = true

  if (
    isEnvTruthy(process.env.COPILOT_CLI_USE_BEDROCK) ||
    isEnvTruthy(process.env.COPILOT_CLI_USE_VERTEX) ||
    isEnvTruthy(process.env.COPILOT_CLI_USE_FOUNDRY)
  ) {
    return
  }

  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ANTHROPIC_UNIX_SOCKET ||
    process.env.COPILOT_CLI_CLIENT_CERT ||
    process.env.COPILOT_CLI_CLIENT_KEY
  ) {
    return
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_API_URL
  void fetch(baseUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(PRECONNECT_TIMEOUT_MS),
  }).catch(() => {})
}

export function resetApiPreconnectForTesting(): void {
  fired = false
}
