/**
 * OAuth 2.0 endpoints, scopes, client IDs, and allowlisted custom-URL overrides.
 */

import { isEnvTruthy } from '../utilities/env_utils.js'

export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference'
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile'
const CONSOLE_SCOPE = 'org:create_api_key'

export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

export const CONSOLE_OAUTH_SCOPES = [CONSOLE_SCOPE, CLAUDE_AI_PROFILE_SCOPE]

export const CLAUDE_AI_OAUTH_SCOPES = [
  CLAUDE_AI_PROFILE_SCOPE,
  CLAUDE_AI_INFERENCE_SCOPE,
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

export const ALL_OAUTH_SCOPES = Array.from(
  new Set([...CONSOLE_OAUTH_SCOPES, ...CLAUDE_AI_OAUTH_SCOPES]),
)

export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'

export interface OauthConfig {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  CLAUDE_AI_AUTHORIZE_URL: string
  CLAUDE_AI_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  CLAUDEAI_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

const ALLOWED_CUSTOM_OAUTH_URLS = new Set([
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
])

const PROD_OAUTH_CONFIG: OauthConfig = {
  BASE_API_URL: 'https://api.anthropic.com',
  CONSOLE_AUTHORIZE_URL: 'https://platform.claude.com/oauth/authorize',
  CLAUDE_AI_AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
  CLAUDE_AI_ORIGIN: 'https://claude.ai',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  API_KEY_URL: 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
  ROLES_URL: 'https://api.anthropic.com/api/oauth/claude_cli/roles',
  CONSOLE_SUCCESS_URL:
    'https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
  CLAUDEAI_SUCCESS_URL:
    'https://platform.claude.com/oauth/code/success?app=claude-code',
  MANUAL_REDIRECT_URL: 'https://platform.claude.com/oauth/code/callback',
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: 'https://mcp-proxy.anthropic.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
}

const STAGING_OAUTH_CONFIG: OauthConfig = {
  BASE_API_URL: 'https://api-staging.anthropic.com',
  CONSOLE_AUTHORIZE_URL:
    'https://platform.staging.ant.dev/oauth/authorize',
  CLAUDE_AI_AUTHORIZE_URL:
    'https://claude-ai.staging.ant.dev/oauth/authorize',
  CLAUDE_AI_ORIGIN: 'https://claude-ai.staging.ant.dev',
  TOKEN_URL: 'https://platform.staging.ant.dev/v1/oauth/token',
  API_KEY_URL:
    'https://api-staging.anthropic.com/api/oauth/claude_cli/create_api_key',
  ROLES_URL: 'https://api-staging.anthropic.com/api/oauth/claude_cli/roles',
  CONSOLE_SUCCESS_URL:
    'https://platform.staging.ant.dev/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
  CLAUDEAI_SUCCESS_URL:
    'https://platform.staging.ant.dev/oauth/code/success?app=claude-code',
  MANUAL_REDIRECT_URL:
    'https://platform.staging.ant.dev/oauth/code/callback',
  CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
  OAUTH_FILE_SUFFIX: '-staging-oauth',
  MCP_PROXY_URL: 'https://mcp-proxy.staging.ant.dev',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
}

function getLocalOauthConfig(): OauthConfig {
  const apiBase = (
    process.env.CLAUDE_LOCAL_OAUTH_API_BASE || 'http://localhost:8000'
  ).replace(/\/+$/, '')
  const appsBase = (
    process.env.CLAUDE_LOCAL_OAUTH_APPS_BASE || 'http://localhost:4000'
  ).replace(/\/+$/, '')
  const consoleBase = (
    process.env.CLAUDE_LOCAL_OAUTH_CONSOLE_BASE || 'http://localhost:3000'
  ).replace(/\/+$/, '')
  return {
    BASE_API_URL: apiBase,
    CONSOLE_AUTHORIZE_URL: `${consoleBase}/oauth/authorize`,
    CLAUDE_AI_AUTHORIZE_URL: `${appsBase}/oauth/authorize`,
    CLAUDE_AI_ORIGIN: appsBase,
    TOKEN_URL: `${consoleBase}/v1/oauth/token`,
    API_KEY_URL: `${apiBase}/api/oauth/claude_cli/create_api_key`,
    ROLES_URL: `${apiBase}/api/oauth/claude_cli/roles`,
    CONSOLE_SUCCESS_URL: `${consoleBase}/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code`,
    CLAUDEAI_SUCCESS_URL: `${consoleBase}/oauth/code/success?app=claude-code`,
    MANUAL_REDIRECT_URL: `${consoleBase}/oauth/code/callback`,
    CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
    OAUTH_FILE_SUFFIX: '-local-oauth',
    MCP_PROXY_URL: apiBase,
    MCP_PROXY_PATH: '/v1/mcp/{server_id}',
  }
}

function buildCustomOauthConfig(rawUrl: string): OauthConfig {
  const base = rawUrl.trim().replace(/\/+$/, '')
  if (!ALLOWED_CUSTOM_OAUTH_URLS.has(base)) {
    throw new Error(
      `COPILOT_CLI_CUSTOM_OAUTH_URL "${rawUrl}" is not in the allowed OAuth endpoint allowlist.`,
    )
  }
  return {
    BASE_API_URL: base,
    CONSOLE_AUTHORIZE_URL: `${base}/oauth/authorize`,
    CLAUDE_AI_AUTHORIZE_URL: `${base}/oauth/authorize`,
    CLAUDE_AI_ORIGIN: base,
    TOKEN_URL: `${base}/v1/oauth/token`,
    API_KEY_URL: `${base}/api/oauth/claude_cli/create_api_key`,
    ROLES_URL: `${base}/api/oauth/claude_cli/roles`,
    CONSOLE_SUCCESS_URL: `${base}/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code`,
    CLAUDEAI_SUCCESS_URL: `${base}/oauth/code/success?app=claude-code`,
    MANUAL_REDIRECT_URL: `${base}/oauth/code/callback`,
    CLIENT_ID: PROD_OAUTH_CONFIG.CLIENT_ID,
    OAUTH_FILE_SUFFIX: '-custom-oauth',
    MCP_PROXY_URL: base,
    MCP_PROXY_PATH: '/v1/mcp/{server_id}',
  }
}

/**
 * Returns the file/keychain suffix corresponding to the active OAuth environment.
 */
export function fileSuffixForOauthConfig(): string {
  if (process.env.COPILOT_CLI_CUSTOM_OAUTH_URL) {
    return '-custom-oauth'
  }
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) {
      return '-local-oauth'
    }
    if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
      return '-staging-oauth'
    }
  }
  return ''
}

/**
 * Resolves the active OAuth configuration, applying allowlisted custom URL
 * and client ID overrides.
 */
export function getOauthConfig(): OauthConfig {
  let config: OauthConfig
  const customUrl = process.env.COPILOT_CLI_CUSTOM_OAUTH_URL
  if (customUrl) {
    config = buildCustomOauthConfig(customUrl)
  } else if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) {
      config = getLocalOauthConfig()
    } else if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
      config = STAGING_OAUTH_CONFIG
    } else {
      config = PROD_OAUTH_CONFIG
    }
  } else {
    config = PROD_OAUTH_CONFIG
  }

  const clientIdOverride = process.env.COPILOT_CLI_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    return { ...config, CLIENT_ID: clientIdOverride }
  }
  return config
}
