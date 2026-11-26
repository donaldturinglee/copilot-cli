/**
 * Pure domain types for cross-platform credential secure storage
 * (macOS Keychain and 0600 plaintext fallback).
 */

import type {
  RateLimitTier,
  SubscriptionType,
} from '../../services/oauth/types.js'

export interface StoredOauthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
}

export interface McpOauthEntry {
  serverName: string
  serverUrl: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  stepUpScope?: string
  clientId?: string
  clientSecret?: string
  discoveryState?: {
    authorizationServerUrl: string
    resourceMetadataUrl?: string
    resourceMetadata?: unknown
    authorizationServerMetadata?: unknown
  }
}

export interface SecureStorageData {
  claudeAiOauth?: StoredOauthTokens
  trustedDeviceToken?: string
  mcpOAuth?: Record<string, McpOauthEntry>
  mcpOAuthClientConfig?: Record<string, { clientSecret?: string }>
  mcpXaaIdp?: Record<string, { idToken: string; expiresAt: number }>
  mcpXaaIdpConfig?: Record<string, { clientSecret: string }>
}

export interface SecureStorageUpdateResult {
  success: boolean
  warning?: string
}

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): SecureStorageUpdateResult
  delete(): boolean
}
