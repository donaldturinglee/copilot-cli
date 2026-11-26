/**
 * OAuth 2.0 HTTP protocol helpers: authorization URL construction, PKCE token
 * exchange, token refresh, profile fetching, and user role retrieval.
 */

import axios from 'axios'
import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  getOauthConfig,
} from '../../constants/oauth.js'
import {
  type AccountInfo,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utilities/config.js'
import { logError } from '../../utilities/log.js'
import { getSecureStorage } from '../../utilities/secure_storage/index.js'
import { getOauthProfileFromOauthToken } from './get_oauth_profile.js'
import type {
  BillingType,
  OauthProfileResponse,
  OauthTokenExchangeResponse,
  OauthTokens,
  RateLimitTier,
  SubscriptionType,
  UserRolesResponse,
} from './types.js'

const TOKEN_REQUEST_TIMEOUT_MS = 15_000
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000

export interface BuildAuthUrlParams {
  codeChallenge: string
  state: string
  port: number
  isManual: boolean
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  orgUuid?: string
  loginHint?: string
  loginMethod?: string
}

export interface ProfileInfoResult {
  subscriptionType: SubscriptionType | null
  displayName?: string
  rateLimitTier: RateLimitTier | null
  hasExtraUsageEnabled: boolean
  billingType: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  rawProfile?: OauthProfileResponse
}

/**
 * Returns true if the OAuth scope list grants Claude.ai inference access.
 */
export function shouldUseClaudeAiAuth(scopes?: readonly string[]): boolean {
  return Boolean(scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE))
}

/**
 * Parses a space-delimited OAuth scope string into an array of non-empty scopes.
 */
export function parseScopes(scopeString?: string): string[] {
  return scopeString?.split(' ').filter(Boolean) ?? []
}

/**
 * Builds an OAuth 2.0 PKCE (`S256`) authorization URL for either localhost
 * automatic callback or manual copy-paste code flow.
 */
export function buildAuthUrl({
  codeChallenge,
  state,
  port,
  isManual,
  loginWithClaudeAi,
  inferenceOnly,
  orgUuid,
  loginHint,
  loginMethod,
}: BuildAuthUrlParams): string {
  const oauthConfig = getOauthConfig()
  const baseUrl = loginWithClaudeAi
    ? oauthConfig.CLAUDE_AI_AUTHORIZE_URL
    : oauthConfig.CONSOLE_AUTHORIZE_URL
  const url = new URL(baseUrl)

  const redirectUri = isManual
    ? oauthConfig.MANUAL_REDIRECT_URL
    : `http://localhost:${port}/callback`
  const scopes = inferenceOnly
    ? [CLAUDE_AI_INFERENCE_SCOPE]
    : ALL_OAUTH_SCOPES

  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', oauthConfig.CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  if (orgUuid) {
    url.searchParams.set('orgUUID', orgUuid)
  }
  if (loginHint) {
    url.searchParams.set('login_hint', loginHint)
  }
  if (loginMethod) {
    url.searchParams.set('login_method', loginMethod)
  }

  return url.toString()
}

/**
 * Exchanges an OAuth authorization code and PKCE verifier for access/refresh tokens.
 */
export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: string,
  codeVerifier: string,
  port: number,
  useManualRedirect = false,
  expiresIn?: number,
): Promise<OauthTokenExchangeResponse> {
  const oauthConfig = getOauthConfig()
  const redirectUri = useManualRedirect
    ? oauthConfig.MANUAL_REDIRECT_URL
    : `http://localhost:${port}/callback`

  const payload: Record<string, unknown> = {
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: redirectUri,
    client_id: oauthConfig.CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  }
  if (expiresIn !== undefined) {
    payload.expires_in = expiresIn
  }

  const response = await axios.post<OauthTokenExchangeResponse>(
    oauthConfig.TOKEN_URL,
    payload,
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: TOKEN_REQUEST_TIMEOUT_MS,
    },
  )
  return response.data
}

/**
 * Returns true if an OAuth token is expired or within the 5-minute refresh buffer.
 */
export function isOauthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) {
    return false
  }
  return Date.now() + TOKEN_EXPIRY_BUFFER_MS >= expiresAt
}

function mapOrganizationTypeToSubscription(
  organizationType?: string | null,
): SubscriptionType | null {
  switch (organizationType) {
    case 'claude_max':
      return 'max'
    case 'claude_pro':
      return 'pro'
    case 'claude_enterprise':
      return 'enterprise'
    case 'claude_team':
      return 'team'
    default:
      return null
  }
}

/**
 * Fetches OAuth profile info and normalizes organization subscription fields.
 */
export async function fetchProfileInfo(
  accessToken: string,
): Promise<ProfileInfoResult> {
  const profile = await getOauthProfileFromOauthToken(accessToken)
  if (!profile) {
    return {
      subscriptionType: null,
      rateLimitTier: null,
      hasExtraUsageEnabled: false,
      billingType: null,
    }
  }

  return {
    subscriptionType: mapOrganizationTypeToSubscription(
      profile.organization?.organization_type,
    ),
    displayName: profile.account?.display_name ?? undefined,
    rateLimitTier: profile.organization?.rate_limit_tier ?? null,
    hasExtraUsageEnabled: Boolean(profile.organization?.has_extra_usage_enabled),
    billingType: profile.organization?.billing_type ?? null,
    accountCreatedAt: profile.account?.created_at ?? undefined,
    subscriptionCreatedAt:
      profile.organization?.subscription_created_at ?? undefined,
    rawProfile: profile,
  }
}

/**
 * Persists OAuth account metadata to `globalConfig.oauthAccount` only when any
 * field actually changed.
 */
export function storeOauthAccountInfo(accountInfo: AccountInfo): void {
  saveGlobalConfig(current => {
    const prev = current.oauthAccount
    if (
      prev &&
      prev.accountUuid === accountInfo.accountUuid &&
      prev.emailAddress === accountInfo.emailAddress &&
      prev.organizationUuid === accountInfo.organizationUuid &&
      prev.organizationName === accountInfo.organizationName &&
      prev.organizationRole === accountInfo.organizationRole &&
      prev.workspaceRole === accountInfo.workspaceRole &&
      prev.displayName === accountInfo.displayName &&
      prev.hasExtraUsageEnabled === accountInfo.hasExtraUsageEnabled &&
      prev.billingType === accountInfo.billingType &&
      prev.accountCreatedAt === accountInfo.accountCreatedAt &&
      prev.subscriptionCreatedAt === accountInfo.subscriptionCreatedAt
    ) {
      return current
    }
    return {
      ...current,
      oauthAccount: accountInfo,
    }
  })
}

/**
 * Refreshes an OAuth access token using a refresh token, skipping the extra
 * profile HTTP call when account and subscription metadata are already cached.
 */
export async function refreshOauthToken(
  refreshToken: string,
  options: { scopes?: string[] } = {},
): Promise<OauthTokens> {
  const oauthConfig = getOauthConfig()
  const requestedScopes =
    options.scopes && options.scopes.length > 0
      ? options.scopes
      : CLAUDE_AI_OAUTH_SCOPES

  const response = await axios.post<OauthTokenExchangeResponse>(
    oauthConfig.TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: oauthConfig.CLIENT_ID,
      scope: requestedScopes.join(' '),
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: TOKEN_REQUEST_TIMEOUT_MS,
    },
  )

  const data = response.data
  const expiresAt = Date.now() + data.expires_in * 1000
  const scopes = parseScopes(data.scope)
  const resolvedScopes = scopes.length > 0 ? scopes : requestedScopes

  const existingConfig = getGlobalConfig()
  const existingAccount = existingConfig.oauthAccount
  const existingStored = getSecureStorage().read()?.claudeAiOauth

  const canSkipProfileFetch =
    Boolean(existingAccount?.billingType) &&
    Boolean(existingAccount?.accountCreatedAt) &&
    Boolean(existingAccount?.subscriptionCreatedAt) &&
    existingStored?.subscriptionType != null &&
    existingStored?.rateLimitTier != null

  if (canSkipProfileFetch) {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt,
      scopes: resolvedScopes,
      subscriptionType: existingStored?.subscriptionType ?? null,
      rateLimitTier: existingStored?.rateLimitTier ?? null,
    }
  }

  const profileInfo = await fetchProfileInfo(data.access_token)
  if (profileInfo.rawProfile) {
    storeOauthAccountInfo({
      ...(existingAccount ?? {
        accountUuid: profileInfo.rawProfile.account.uuid,
        emailAddress: profileInfo.rawProfile.account.email,
      }),
      accountUuid:
        profileInfo.rawProfile.account.uuid || existingAccount?.accountUuid || '',
      emailAddress:
        profileInfo.rawProfile.account.email ||
        existingAccount?.emailAddress ||
        '',
      organizationUuid:
        profileInfo.rawProfile.organization.uuid ??
        existingAccount?.organizationUuid,
      displayName: profileInfo.displayName ?? existingAccount?.displayName,
      hasExtraUsageEnabled: profileInfo.hasExtraUsageEnabled,
      billingType: profileInfo.billingType,
      accountCreatedAt:
        profileInfo.accountCreatedAt ?? existingAccount?.accountCreatedAt,
      subscriptionCreatedAt:
        profileInfo.subscriptionCreatedAt ??
        existingAccount?.subscriptionCreatedAt,
    })
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
    scopes: resolvedScopes,
    subscriptionType:
      profileInfo.subscriptionType ?? existingStored?.subscriptionType ?? null,
    rateLimitTier:
      profileInfo.rateLimitTier ?? existingStored?.rateLimitTier ?? null,
    profile: profileInfo.rawProfile,
  }
}

/**
 * Fetches organization and workspace roles and merges them into `globalConfig.oauthAccount`.
 */
export async function fetchAndStoreUserRoles(
  accessToken: string,
): Promise<UserRolesResponse | null> {
  try {
    const response = await axios.get<UserRolesResponse>(
      getOauthConfig().ROLES_URL,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: TOKEN_REQUEST_TIMEOUT_MS,
      },
    )
    const roles = response.data
    const existing = getGlobalConfig().oauthAccount
    if (existing) {
      storeOauthAccountInfo({
        ...existing,
        organizationRole: roles.organization_role,
        workspaceRole: roles.workspace_role,
        organizationName: roles.organization_name,
      })
    }
    return roles
  } catch (error) {
    logError(error)
    return null
  }
}

/**
 * Calls Anthropic's OAuth API key creation endpoint and returns the raw key string.
 */
export async function createApiKeyFromOauthToken(
  accessToken: string,
): Promise<string | null> {
  const response = await axios.post<{ raw_key?: string }>(
    getOauthConfig().API_KEY_URL,
    null,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: TOKEN_REQUEST_TIMEOUT_MS,
    },
  )
  return response.data?.raw_key ?? null
}
