import { getClaudeCodeUserAgent } from './user_agent.js'
import { getWorkload } from './workload_context.js'

const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

export type HttpAuthProvider = {
  isClaudeAiSubscriber: () => boolean
  getOauthAccessToken: () => string | undefined
  getApiKey: () => string | undefined
  handleOauth401Error: (failedAccessToken: string | undefined) => Promise<void>
}

let authProvider: HttpAuthProvider | undefined

/**
 * Registers the Phase 2 authentication provider so `http.ts` supports OAuth
 * and API-key helper flows with zero backward imports in Phase 1.
 */
export function registerHttpAuthProvider(
  provider: HttpAuthProvider | undefined,
): void {
  authProvider = provider
}

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

export function getUserAgent(): string {
  const version = getMacroVersion()
  const userType = process.env.USER_TYPE || 'external'
  const entrypoint = process.env.COPILOT_CLI_ENTRYPOINT ?? 'cli'
  const sdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : ''
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : ''
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `claude-cli/${version} (${userType}, ${entrypoint}${sdkVersion}${clientApp}${workloadSuffix})`
}

export function getMcpUserAgent(): string {
  const base = getClaudeCodeUserAgent()
  const parts: string[] = []
  if (process.env.COPILOT_CLI_ENTRYPOINT) {
    parts.push(process.env.COPILOT_CLI_ENTRYPOINT)
  }
  if (process.env.CLAUDE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`)
  }
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`)
  }
  return parts.length > 0 ? `${base} (${parts.join(', ')})` : base
}

export function getWebFetchUserAgent(): string {
  return `Claude-User (${getClaudeCodeUserAgent()}; +https://support.anthropic.com/)`
}

export function getAuthHeaders(): AuthHeaders {
  if (authProvider?.isClaudeAiSubscriber()) {
    const accessToken = authProvider.getOauthAccessToken()
    if (!accessToken) {
      return { headers: {}, error: 'No OAuth token available' }
    }
    return {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }

  const apiKey = authProvider
    ? authProvider.getApiKey()
    : process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { headers: {}, error: 'No API key available' }
  }
  return {
    headers: {
      'x-api-key': apiKey,
    },
  }
}

export async function withOauth401Retry<Result>(
  request: () => Promise<Result>,
  options?: { also403Revoked?: boolean },
): Promise<Result> {
  try {
    return await request()
  } catch (error) {
    const axiosError = error as {
      isAxiosError?: boolean
      response?: { status?: number; data?: unknown }
    }
    const status = axiosError?.isAxiosError
      ? axiosError.response?.status
      : undefined
    const is401 = status === 401
    const isRevoked403 =
      Boolean(options?.also403Revoked) &&
      status === 403 &&
      typeof axiosError.response?.data === 'string' &&
      axiosError.response.data.includes('OAuth token has been revoked')

    if ((is401 || isRevoked403) && authProvider) {
      const failedAccessToken = authProvider.getOauthAccessToken()
      await authProvider.handleOauth401Error(failedAccessToken)
      return await request()
    }
    throw error
  }
}
