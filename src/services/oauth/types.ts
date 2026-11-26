/**
 * Pure domain types for OAuth 2.0 PKCE authentication, user profiles, and
 * subscription tiers (reconstructed from call sites across auth & API layers).
 */

export type SubscriptionType = 'max' | 'pro' | 'enterprise' | 'team'

export type RateLimitTier =
  | 'default_claude_max_5x'
  | 'default_claude_max_20x'
  | (string & {})

export type BillingType =
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'
  | (string & {})

export interface OauthProfileResponse {
  account: {
    uuid: string
    email: string
    display_name?: string | null
    created_at?: string
  }
  organization: {
    uuid: string
    organization_type?:
      | 'claude_max'
      | 'claude_pro'
      | 'claude_enterprise'
      | 'claude_team'
      | string
      | null
    rate_limit_tier?: RateLimitTier | null
    has_extra_usage_enabled?: boolean | null
    billing_type?: BillingType | null
    subscription_created_at?: string | null
  }
}

export interface OauthTokenExchangeResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  token_type?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

export interface UserRolesResponse {
  organization_role: string | null
  workspace_role: string | null
  organization_name: string | null
}

export interface OauthTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OauthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}
