/**
 * Unified authentication manager: API key resolution & SWR `apiKeyHelper`,
 * OAuth 2.0 token storage/refresh with cross-process lockfile synchronization,
 * AWS/GCP credential refresh, OTel headers helper, and logout cleanup.
 */

import { execa, execaSync } from 'execa'
import memoize from 'lodash-es/memoize.js'
import {
  preferThirdPartyAuthentication,
  setApiKeyFromFd,
  setOauthTokenFromFd,
} from '../bootstrap/state.js'
import {
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_PROFILE_SCOPE,
} from '../constants/oauth.js'
import {
  createApiKeyFromOauthToken,
  fetchProfileInfo,
  isOauthTokenExpired,
  refreshOauthToken,
  shouldUseClaudeAiAuth,
  storeOauthAccountInfo,
} from '../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../services/oauth/get_oauth_profile.js'
import type {
  OauthTokens,
  RateLimitTier,
  SubscriptionType,
} from '../services/oauth/types.js'
import { registerSettingsChangeAuthCacheInvalidator } from '../state/on_change_app_state.js'
import {
  getApiKeyFromFileDescriptor,
  getOauthTokenFromFileDescriptor,
} from './auth_file_descriptor.js'
import {
  maybeRemoveApiKeyFromMacOsKeychainThrows,
  normalizeApiKeyForConfig,
} from './auth_portable.js'
import {
  type AwsCredentials,
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './aws_auth_status_manager.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import { logForDebugging } from './debug.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
} from './env_utils.js'
import { isEnoent } from './errors.js'
import { getFsImplementation } from './fs_operations.js'
import { registerHttpAuthProvider } from './http.js'
import { safeParseJson } from './json.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { memoizeWithTtlAsync } from './memoize.js'
import { importOptionalModule } from './optional_import.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './secure_storage/mac_os_keychain_helpers.js'
import { getSecureStorage } from './secure_storage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from './secure_storage/keychain_prefetch.js'
import { getPlainTextCredentialsPath } from './secure_storage/plain_text_storage.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'

export type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'none'

export type AuthTokenSourceKind =
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'COPILOT_CLI_OAUTH_TOKEN'
  | 'COPILOT_CLI_OAUTH_TOKEN_FILE_DESCRIPTOR'
  | 'CCR_OAUTH_TOKEN_FILE'
  | 'apiKeyHelper'
  | 'claude.ai'
  | 'none'

export interface AuthTokenSource {
  source: AuthTokenSourceKind
  hasToken: boolean
}

export interface AccountInformation {
  email?: string
  organization?: string
  subscription?: string
  tokenSource?: string
  apiKeySource?: string
}

const DEFAULT_API_KEY_HELPER_TTL_MS = 5 * 60 * 1000
const API_KEY_HELPER_TIMEOUT_MS = 10 * 60 * 1000
const CLOUD_AUTH_REFRESH_TTL_MS = 60 * 60 * 1000
const CLOUD_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000
const GCP_CHECK_TIMEOUT_MS = 5_000
const DEFAULT_OTEL_HELPER_DEBOUNCE_MS = 29 * 60 * 1000
const OTEL_HELPER_TIMEOUT_MS = 30_000
const MAX_REFRESH_LOCK_RETRIES = 5
const VALID_API_KEY_REGEX = /^[a-zA-Z0-9-_]+$/

const ALLOWED_OVERAGE_BILLING_TYPES = new Set<string>([
  'stripe_subscription',
  'stripe_subscription_contracted',
  'apple_subscription',
  'google_play_subscription',
])

const authMutationListeners = new Set<() => void>()

/**
 * Registers a callback invoked when OAuth/auth credentials change so downstream
 * caches (betas, tool schemas) can invalidate without circular imports.
 */
export function registerAuthCacheInvalidator(
  listener: () => void,
): () => void {
  authMutationListeners.add(listener)
  return () => {
    authMutationListeners.delete(listener)
  }
}

function notifyAuthCacheInvalidators(): void {
  for (const listener of authMutationListeners) {
    try {
      listener()
    } catch {
      // Never let a cache listener break auth operations
    }
  }
}

/**
 * Returns true when running inside a host-managed OAuth context (CCR remote
 * or Claude Desktop) where OAuth takes precedence over ambient API keys.
 */
export function isManagedOauthContext(): boolean {
  return (
    isEnvTruthy(process.env.COPILOT_CLI_REMOTE) ||
    process.env.COPILOT_CLI_ENTRYPOINT === 'claude-desktop'
  )
}

/**
 * Returns true if the process is configured to use a 3P cloud provider.
 */
export function isUsing3pServices(): boolean {
  return (
    isEnvTruthy(process.env.COPILOT_CLI_USE_BEDROCK) ||
    isEnvTruthy(process.env.COPILOT_CLI_USE_VERTEX) ||
    isEnvTruthy(process.env.COPILOT_CLI_USE_FOUNDRY)
  )
}

/**
 * Resolves the configured `apiKeyHelper` shell command, honoring bare mode
 * (`flagSettings` only) and trusting project/local settings only after trust.
 */
export function getConfiguredApiKeyHelper(): {
  command: string | undefined
  fromProjectOrLocal: boolean
} {
  if (isBareMode()) {
    const flagHelper = getSettingsForSource('flagSettings')?.apiKeyHelper
    return { command: flagHelper, fromProjectOrLocal: false }
  }

  const policy = getSettingsForSource('policySettings')?.apiKeyHelper
  if (policy) return { command: policy, fromProjectOrLocal: false }

  const flag = getSettingsForSource('flagSettings')?.apiKeyHelper
  if (flag) return { command: flag, fromProjectOrLocal: false }

  const local = getSettingsForSource('localSettings')?.apiKeyHelper
  if (local) return { command: local, fromProjectOrLocal: true }

  const project = getSettingsForSource('projectSettings')?.apiKeyHelper
  if (project) return { command: project, fromProjectOrLocal: true }

  const user = getSettingsForSource('userSettings')?.apiKeyHelper
  if (user) return { command: user, fromProjectOrLocal: false }

  const globalHelper = getGlobalConfig().apiKeyHelper
  return { command: globalHelper, fromProjectOrLocal: false }
}

/**
 * Returns true when Anthropic first-party OAuth authentication is enabled.
 */
export function isAnthropicAuthEnabled(): boolean {
  if (isBareMode()) {
    return false
  }
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return Boolean(process.env.COPILOT_CLI_OAUTH_TOKEN)
  }
  if (isUsing3pServices()) {
    return false
  }
  if (!isManagedOauthContext()) {
    const hasExternalAuthToken = Boolean(
      process.env.ANTHROPIC_AUTH_TOKEN ||
        getConfiguredApiKeyHelper().command ||
        process.env.COPILOT_CLI_API_KEY_FILE_DESCRIPTOR,
    )
    const hasExternalApiKey = Boolean(
      process.env.ANTHROPIC_API_KEY || getConfiguredApiKeyHelper().command,
    )
    if (hasExternalAuthToken || hasExternalApiKey) {
      return false
    }
  }
  return true
}

// =============================================================================
// API Key Helper (SWR + Epoch + Trust Gate)
// =============================================================================

let apiKeyHelperCache: { value: string | null; fetchedAt: number } | null = null
let apiKeyHelperInflight: Promise<string | null> | null = null
let apiKeyHelperEpoch = 0

/**
 * Computes the effective `apiKeyHelper` TTL in milliseconds.
 */
export function calculateApiKeyHelperTtl(): number {
  const raw = process.env.COPILOT_CLI_API_KEY_HELPER_TTL_MS
  if (raw) {
    const parsed = Number(raw)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return DEFAULT_API_KEY_HELPER_TTL_MS
}

/**
 * Returns milliseconds elapsed since the last `apiKeyHelper` fetch, or null.
 */
export function getApiKeyHelperElapsedMs(): number | null {
  if (!apiKeyHelperCache) {
    return null
  }
  return Date.now() - apiKeyHelperCache.fetchedAt
}

/**
 * Clears cached `apiKeyHelper` values and increments epoch to ignore stale runs.
 */
export function clearApiKeyHelperCache(): void {
  apiKeyHelperCache = null
  apiKeyHelperInflight = null
  apiKeyHelperEpoch++
}

async function executeApiKeyHelper(
  command: string,
  epoch: number,
  isSwrRefresh: boolean,
): Promise<string | null> {
  try {
    const result = await execa(command, {
      shell: true,
      timeout: API_KEY_HELPER_TIMEOUT_MS,
      reject: false,
    })
    if (epoch !== apiKeyHelperEpoch) {
      return apiKeyHelperCache?.value ?? null
    }
    const output = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    if (result.exitCode === 0 && output) {
      apiKeyHelperCache = { value: output, fetchedAt: Date.now() }
      return output
    }
    if (isSwrRefresh && apiKeyHelperCache?.value) {
      apiKeyHelperCache = {
        value: apiKeyHelperCache.value,
        fetchedAt: Date.now(),
      }
      return apiKeyHelperCache.value
    }
    // Cold failure sentinel prevents silent fallback to OAuth
    apiKeyHelperCache = { value: ' ', fetchedAt: Date.now() }
    return ' '
  } catch (error) {
    logError(error)
    if (epoch !== apiKeyHelperEpoch) {
      return apiKeyHelperCache?.value ?? null
    }
    if (isSwrRefresh && apiKeyHelperCache?.value) {
      apiKeyHelperCache = {
        value: apiKeyHelperCache.value,
        fetchedAt: Date.now(),
      }
      return apiKeyHelperCache.value
    }
    apiKeyHelperCache = { value: ' ', fetchedAt: Date.now() }
    return ' '
  }
}

/**
 * Returns the cached `apiKeyHelper` value synchronously without spawning a subprocess.
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  const value = apiKeyHelperCache?.value
  if (!value || value === ' ') {
    return null
  }
  return value
}

/**
 * Executes or returns the cached `apiKeyHelper` value with SWR background refresh
 * and workspace trust enforcement for project/local settings.
 */
export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  const { command, fromProjectOrLocal } = getConfiguredApiKeyHelper()
  if (!command) {
    return null
  }
  if (
    fromProjectOrLocal &&
    !checkHasTrustDialogAccepted() &&
    !isNonInteractiveSession
  ) {
    logForDebugging(
      'Refusing to run project/local apiKeyHelper before workspace trust',
    )
    return null
  }

  const ttl = calculateApiKeyHelperTtl()
  const now = Date.now()
  if (apiKeyHelperCache) {
    const age = now - apiKeyHelperCache.fetchedAt
    if (age < ttl) {
      return apiKeyHelperCache.value === ' ' ? null : apiKeyHelperCache.value
    }
    // Stale-while-revalidate: return stale immediately, refresh in background
    if (!apiKeyHelperInflight) {
      const epoch = apiKeyHelperEpoch
      apiKeyHelperInflight = executeApiKeyHelper(command, epoch, true).finally(
        () => {
          apiKeyHelperInflight = null
        },
      )
    }
    return apiKeyHelperCache.value === ' ' ? null : apiKeyHelperCache.value
  }

  if (apiKeyHelperInflight) {
    const resolved = await apiKeyHelperInflight
    return resolved === ' ' ? null : resolved
  }

  const epoch = apiKeyHelperEpoch
  apiKeyHelperInflight = executeApiKeyHelper(command, epoch, false).finally(
    () => {
      apiKeyHelperInflight = null
    },
  )
  const resolved = await apiKeyHelperInflight
  return resolved === ' ' ? null : resolved
}

/**
 * Safely prefetches `apiKeyHelper` if it is not from untrusted project/local settings.
 */
export function prefetchApiKeyFromApiKeyHelperIfSafe(
  isNonInteractiveSession: boolean,
): void {
  const { command, fromProjectOrLocal } = getConfiguredApiKeyHelper()
  if (!command) return
  if (
    fromProjectOrLocal &&
    !checkHasTrustDialogAccepted() &&
    !isNonInteractiveSession
  ) {
    return
  }
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

// =============================================================================
// Legacy API Key Storage & Approval
// =============================================================================

/**
 * Returns true if a custom `ANTHROPIC_API_KEY` suffix is recorded as approved.
 */
export function isCustomApiKeyApproved(apiKey: string): boolean {
  const normalized = normalizeApiKeyForConfig(apiKey)
  const approved = getGlobalConfig().customApiKeyResponses?.approved ?? []
  return approved.includes(normalized)
}

const getApiKeyFromConfigOrMacOsKeychain = memoize((): string | null => {
  if (process.platform === 'darwin') {
    const prefetched = getLegacyApiKeyPrefetchResult()
    if (prefetched.completed) {
      if (prefetched.apiKey) {
        return prefetched.apiKey
      }
    } else {
      try {
        const serviceName = getMacOsKeychainStorageServiceName('')
        const username = getUsername()
        const result = execaSync(
          'security',
          ['find-generic-password', '-a', username, '-w', '-s', serviceName],
          { reject: false, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        if (result.exitCode === 0 && typeof result.stdout === 'string') {
          const trimmed = result.stdout.trim()
          if (trimmed) return trimmed
        }
      } catch {
        // Fall through to globalConfig.primaryApiKey
      }
    }
  }
  return getGlobalConfig().primaryApiKey ?? null
})

/**
 * Validates and persists a managed API key (macOS Keychain on darwin,
 * `globalConfig.primaryApiKey` elsewhere) and records its approval suffix.
 */
export async function saveApiKey(apiKey: string): Promise<void> {
  if (!VALID_API_KEY_REGEX.test(apiKey)) {
    throw new Error('Invalid API key format.')
  }

  if (process.platform === 'darwin') {
    try {
      await maybeRemoveApiKeyFromMacOsKeychainThrows()
    } catch {
      // Ignore deletion errors if entry did not exist
    }
    const serviceName = getMacOsKeychainStorageServiceName('')
    const username = getUsername()
    const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')
    const cmd = `add-generic-password -U -a "${username}" -s "${serviceName}" -X "${hexValue}"\n`
    const result = execaSync('security', ['-i'], {
      input: cmd,
      stdio: ['pipe', 'pipe', 'pipe'],
      reject: false,
    })
    if (result.exitCode !== 0) {
      saveGlobalConfig(current => ({
        ...current,
        primaryApiKey: apiKey,
      }))
    }
  } else {
    saveGlobalConfig(current => ({
      ...current,
      primaryApiKey: apiKey,
    }))
  }

  const suffix = normalizeApiKeyForConfig(apiKey)
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    const rejected = (current.customApiKeyResponses?.rejected ?? []).filter(
      item => item !== suffix,
    )
    return {
      ...current,
      customApiKeyResponses: {
        approved: approved.includes(suffix) ? approved : [...approved, suffix],
        rejected,
      },
    }
  })

  getApiKeyFromConfigOrMacOsKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
  notifyAuthCacheInvalidators()
}

/**
 * Removes any stored managed API key from Keychain and global config.
 */
export async function removeApiKey(): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await maybeRemoveApiKeyFromMacOsKeychainThrows()
    } catch {
      // Ignore if absent
    }
  }
  saveGlobalConfig(current => {
    const { primaryApiKey: _removed, ...rest } = current
    return rest
  })
  getApiKeyFromConfigOrMacOsKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
  notifyAuthCacheInvalidators()
}

/**
 * Resolves the active Anthropic API key and its provenance source.
 */
export function getAnthropicApiKeyWithSource(options?: {
  skipRetrievingKeyFromApiKeyHelper?: boolean
}): { key: string | null; source: ApiKeySource } {
  const apiKeyEnv = process.env.ANTHROPIC_API_KEY

  if (isBareMode()) {
    if (apiKeyEnv) {
      return { key: apiKeyEnv, source: 'ANTHROPIC_API_KEY' }
    }
    if (!options?.skipRetrievingKeyFromApiKeyHelper) {
      const helperKey = getApiKeyFromApiKeyHelperCached()
      if (helperKey) {
        return { key: helperKey, source: 'apiKeyHelper' }
      }
    }
    return { key: null, source: 'none' }
  }

  if (preferThirdPartyAuthentication() && apiKeyEnv) {
    return { key: apiKeyEnv, source: 'ANTHROPIC_API_KEY' }
  }

  if (isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test') {
    const fdKey = getApiKeyFromFileDescriptor()
    if (fdKey) {
      return { key: fdKey, source: 'ANTHROPIC_API_KEY' }
    }
    if (apiKeyEnv) {
      return { key: apiKeyEnv, source: 'ANTHROPIC_API_KEY' }
    }
    if (!options?.skipRetrievingKeyFromApiKeyHelper) {
      const helperKey = getApiKeyFromApiKeyHelperCached()
      if (helperKey) {
        return { key: helperKey, source: 'apiKeyHelper' }
      }
    }
    return { key: null, source: 'none' }
  }

  if (apiKeyEnv && isCustomApiKeyApproved(apiKeyEnv)) {
    return { key: apiKeyEnv, source: 'ANTHROPIC_API_KEY' }
  }

  const fdKey = getApiKeyFromFileDescriptor()
  if (fdKey) {
    return { key: fdKey, source: 'ANTHROPIC_API_KEY' }
  }

  if (!options?.skipRetrievingKeyFromApiKeyHelper) {
    const helperKey = getApiKeyFromApiKeyHelperCached()
    if (helperKey) {
      return { key: helperKey, source: 'apiKeyHelper' }
    }
  }

  const storedKey = getApiKeyFromConfigOrMacOsKeychain()
  if (storedKey) {
    return { key: storedKey, source: '/login managed key' }
  }

  return { key: null, source: 'none' }
}

/**
 * Convenience accessor returning the resolved Anthropic API key string or null.
 */
export function getAnthropicApiKey(options?: {
  skipRetrievingKeyFromApiKeyHelper?: boolean
}): string | null {
  return getAnthropicApiKeyWithSource(options).key
}

// =============================================================================
// OAuth Token Reading, Storage, Cross-Process Refresh & 401 Recovery
// =============================================================================

let lastCredentialsFileMtime: number | null = null

/**
 * Invalidates in-memory OAuth token caches when `.credentials.json` mtime changes
 * on disk (cross-process token refresh detection).
 */
export function invalidateOauthCacheIfDiskChanged(): void {
  const credentialsPath = getPlainTextCredentialsPath()
  try {
    const stats = getFsImplementation().statSync(credentialsPath)
    if (
      lastCredentialsFileMtime !== null &&
      stats.mtimeMs !== lastCredentialsFileMtime
    ) {
      getClaudeAiOauthTokens.cache.clear?.()
      clearKeychainCache()
      notifyAuthCacheInvalidators()
    }
    lastCredentialsFileMtime = stats.mtimeMs
  } catch (error) {
    if (isEnoent(error)) {
      // On macOS Keychain installs `.credentials.json` does not exist; clear
      // only memoize so the 30s keychain cache governs refreshes.
      getClaudeAiOauthTokens.cache.clear?.()
    }
  }
}

/**
 * Synchronously resolves active Claude.ai OAuth tokens (env > FD > secure storage).
 */
export const getClaudeAiOauthTokens = memoize((): OauthTokens | null => {
  if (isBareMode()) {
    return null
  }
  const envToken = process.env.COPILOT_CLI_OAUTH_TOKEN
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: null,
      expiresAt: null,
      scopes: [CLAUDE_AI_INFERENCE_SCOPE],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }
  const fdToken = getOauthTokenFromFileDescriptor()
  if (fdToken) {
    return {
      accessToken: fdToken,
      refreshToken: null,
      expiresAt: null,
      scopes: [CLAUDE_AI_INFERENCE_SCOPE],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }
  const stored = getSecureStorage().read()?.claudeAiOauth
  if (!stored?.accessToken) {
    return null
  }
  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken || null,
    expiresAt: stored.expiresAt ?? null,
    scopes: stored.scopes ?? [],
    subscriptionType: stored.subscriptionType ?? null,
    rateLimitTier: stored.rateLimitTier ?? null,
  }
})

/**
 * Asynchronously resolves active Claude.ai OAuth tokens (env > FD > secure storage).
 */
export async function getClaudeAiOauthTokensAsync(): Promise<OauthTokens | null> {
  if (isBareMode()) {
    return null
  }
  const envToken = process.env.COPILOT_CLI_OAUTH_TOKEN
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: null,
      expiresAt: null,
      scopes: [CLAUDE_AI_INFERENCE_SCOPE],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }
  const fdToken = getOauthTokenFromFileDescriptor()
  if (fdToken) {
    return {
      accessToken: fdToken,
      refreshToken: null,
      expiresAt: null,
      scopes: [CLAUDE_AI_INFERENCE_SCOPE],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }
  const stored = (await getSecureStorage().readAsync())?.claudeAiOauth
  if (!stored?.accessToken) {
    return null
  }
  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken || null,
    expiresAt: stored.expiresAt ?? null,
    scopes: stored.scopes ?? [],
    subscriptionType: stored.subscriptionType ?? null,
    rateLimitTier: stored.rateLimitTier ?? null,
  }
}

/**
 * Persists OAuth tokens to cross-platform secure storage when eligible (full
 * Claude.ai OAuth tokens with refresh token & expiry), preserving existing
 * subscription/rateLimitTier if omitted.
 */
export function saveOauthTokensIfNeeded(tokens: OauthTokens): {
  success: boolean
  warning?: string
} {
  if (
    !shouldUseClaudeAiAuth(tokens.scopes) ||
    !tokens.refreshToken ||
    tokens.expiresAt === null
  ) {
    return { success: false }
  }

  const storage = getSecureStorage()
  const existingData = storage.read() ?? {}
  const prevOauth = existingData.claudeAiOauth

  const result = storage.update({
    ...existingData,
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType:
        tokens.subscriptionType ?? prevOauth?.subscriptionType ?? null,
      rateLimitTier: tokens.rateLimitTier ?? prevOauth?.rateLimitTier ?? null,
    },
  })

  getClaudeAiOauthTokens.cache.clear?.()
  notifyAuthCacheInvalidators()
  return result
}

let pendingRefreshCheck: Promise<boolean> | null = null
const pending401Handlers = new Map<string, Promise<boolean>>()

/**
 * Checks whether stored OAuth tokens are expired (or `force === true`) and
 * refreshes them under a cross-process directory lockfile to prevent concurrent
 * refresh races.
 */
export async function checkAndRefreshOauthTokenIfNeeded(
  retryCount = 0,
  force = false,
): Promise<boolean> {
  if (retryCount === 0 && !force) {
    if (pendingRefreshCheck) {
      return pendingRefreshCheck
    }
    const run = runOauthRefreshCheck(0, false).finally(() => {
      pendingRefreshCheck = null
    })
    pendingRefreshCheck = run
    return run
  }
  return runOauthRefreshCheck(retryCount, force)
}

async function runOauthRefreshCheck(
  retryCount: number,
  force: boolean,
): Promise<boolean> {
  invalidateOauthCacheIfDiskChanged()
  const tokens = await getClaudeAiOauthTokensAsync()
  if (!tokens?.refreshToken) {
    return false
  }
  if (!force && !isOauthTokenExpired(tokens.expiresAt)) {
    return false
  }

  const lockDir = getClaudeConfigHomeDir()
  let releaseLock: (() => Promise<void>) | null = null
  try {
    releaseLock = await lockfile.lock(lockDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ELOCKED' && retryCount < MAX_REFRESH_LOCK_RETRIES) {
      await sleep(1000 + Math.random() * 1000)
      return runOauthRefreshCheck(retryCount + 1, force)
    }
    logForDebugging(`Failed to acquire OAuth refresh lock: ${String(error)}`)
    return false
  }

  try {
    // Re-read inside lock in case another process already refreshed
    clearKeychainCache()
    getClaudeAiOauthTokens.cache.clear?.()
    const lockedTokens = await getClaudeAiOauthTokensAsync()
    if (!lockedTokens?.refreshToken) {
      return false
    }
    if (
      !force &&
      !isOauthTokenExpired(lockedTokens.expiresAt)
    ) {
      return true
    }
    if (force && lockedTokens.accessToken !== tokens.accessToken) {
      return true
    }

    try {
      const refreshed = await refreshOauthToken(lockedTokens.refreshToken, {
        scopes: shouldUseClaudeAiAuth(lockedTokens.scopes)
          ? undefined
          : lockedTokens.scopes,
      })
      saveOauthTokensIfNeeded(refreshed)
      clearKeychainCache()
      getClaudeAiOauthTokens.cache.clear?.()
      notifyAuthCacheInvalidators()
      return true
    } catch (refreshError) {
      // Check if another process won the race and updated storage
      clearKeychainCache()
      getClaudeAiOauthTokens.cache.clear?.()
      const afterErrorTokens = await getClaudeAiOauthTokensAsync()
      if (
        afterErrorTokens &&
        afterErrorTokens.accessToken !== lockedTokens.accessToken
      ) {
        return true
      }
      logError(refreshError)
      return false
    }
  } finally {
    if (releaseLock) {
      await releaseLock().catch(() => {})
    }
  }
}

/**
 * Handles an HTTP 401/revoked-403 OAuth error by deduplicating concurrent
 * recovery attempts per failed access token and forcing a refresh if needed.
 */
export async function handleOauth401Error(
  failedAccessToken: string | undefined,
): Promise<boolean> {
  const key = failedAccessToken ?? ''
  const existing = pending401Handlers.get(key)
  if (existing) {
    return existing
  }

  const promise = (async (): Promise<boolean> => {
    clearKeychainCache()
    getClaudeAiOauthTokens.cache.clear?.()
    const fresh = await getClaudeAiOauthTokensAsync()
    if (fresh && failedAccessToken && fresh.accessToken !== failedAccessToken) {
      notifyAuthCacheInvalidators()
      return true
    }
    return checkAndRefreshOauthTokenIfNeeded(0, true)
  })().finally(() => {
    pending401Handlers.delete(key)
  })

  pending401Handlers.set(key, promise)
  return promise
}

/**
 * Creates a managed API key from an OAuth access token and stores it locally.
 */
export async function createAndStoreApiKey(
  accessToken: string,
): Promise<string | null> {
  const rawKey = await createApiKeyFromOauthToken(accessToken)
  if (!rawKey) {
    return null
  }
  await saveApiKey(rawKey)
  return rawKey
}

/**
 * Clears all stored OAuth tokens, legacy API keys, and cached account info.
 */
export async function logout(): Promise<void> {
  const storage = getSecureStorage()
  const existing = storage.read()
  if (existing) {
    const { claudeAiOauth: _removedOauth, ...remaining } = existing
    if (Object.keys(remaining).length === 0) {
      storage.delete()
    } else {
      storage.update(remaining)
    }
  } else {
    storage.delete()
  }

  await removeApiKey()

  saveGlobalConfig(current => {
    const {
      oauthAccount: _removedAccount,
      cachedExtraUsageDisabledReason: _removedExtra,
      ...rest
    } = current
    return rest
  })

  clearKeychainCache()
  getClaudeAiOauthTokens.cache.clear?.()
  clearApiKeyHelperCache()
  notifyAuthCacheInvalidators()
}

// =============================================================================
// Auth Source & Subscription Introspection
// =============================================================================

/**
 * Returns the active token authentication source without invoking subprocess helpers.
 */
export function getAuthTokenSource(): AuthTokenSource {
  if (isBareMode()) {
    const flagHelper = getSettingsForSource('flagSettings')?.apiKeyHelper
    return flagHelper
      ? { source: 'apiKeyHelper', hasToken: true }
      : { source: 'none', hasToken: false }
  }

  if (!isManagedOauthContext() && process.env.ANTHROPIC_AUTH_TOKEN) {
    return { source: 'ANTHROPIC_AUTH_TOKEN', hasToken: true }
  }

  if (process.env.COPILOT_CLI_OAUTH_TOKEN) {
    return { source: 'COPILOT_CLI_OAUTH_TOKEN', hasToken: true }
  }

  const fdToken = getOauthTokenFromFileDescriptor()
  if (fdToken) {
    return {
      source: process.env.COPILOT_CLI_OAUTH_TOKEN_FILE_DESCRIPTOR
        ? 'COPILOT_CLI_OAUTH_TOKEN_FILE_DESCRIPTOR'
        : 'CCR_OAUTH_TOKEN_FILE',
      hasToken: true,
    }
  }

  if (!isManagedOauthContext() && getConfiguredApiKeyHelper().command) {
    return { source: 'apiKeyHelper', hasToken: true }
  }

  const oauthTokens = getClaudeAiOauthTokens()
  if (oauthTokens && shouldUseClaudeAiAuth(oauthTokens.scopes)) {
    return { source: 'claude.ai', hasToken: true }
  }

  return { source: 'none', hasToken: false }
}

/**
 * Returns true when authenticated with a Claude.ai OAuth subscription token.
 */
export function isClaudeAiSubscriber(): boolean {
  if (!isAnthropicAuthEnabled()) {
    return false
  }
  const tokens = getClaudeAiOauthTokens()
  return Boolean(tokens && shouldUseClaudeAiAuth(tokens.scopes))
}

/**
 * Returns true if the active OAuth token includes the `user:profile` scope.
 */
export function hasProfileScope(): boolean {
  const tokens = getClaudeAiOauthTokens()
  return Boolean(tokens?.scopes.includes(CLAUDE_AI_PROFILE_SCOPE))
}

/**
 * Returns true when authenticated as a 1P API customer (non-subscriber, non-3P).
 */
export function is1pApiCustomer(): boolean {
  return !isClaudeAiSubscriber() && !isUsing3pServices()
}

/**
 * Returns cached OAuth account metadata from `globalConfig`.
 */
export function getOauthAccountInfo(): AccountInfo | undefined {
  return getGlobalConfig().oauthAccount
}

/**
 * Returns the active subscription type (`max` | `pro` | `enterprise` | `team` | null).
 */
export function getSubscriptionType(): SubscriptionType | null {
  if (!isClaudeAiSubscriber()) {
    return null
  }
  return getClaudeAiOauthTokens()?.subscriptionType ?? null
}

/**
 * Returns the active rate-limit tier from stored OAuth tokens.
 */
export function getRateLimitTier(): RateLimitTier | null {
  if (!isClaudeAiSubscriber()) {
    return null
  }
  return getClaudeAiOauthTokens()?.rateLimitTier ?? null
}

export function isMaxSubscriber(): boolean {
  return getSubscriptionType() === 'max'
}

export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function isTeamSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}

export function isTeamPremiumSubscriber(): boolean {
  return (
    getSubscriptionType() === 'team' &&
    getRateLimitTier() === 'default_claude_max_5x'
  )
}

export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}

export function isConsumerSubscriber(): boolean {
  const sub = getSubscriptionType()
  return sub === 'max' || sub === 'pro'
}

export function hasOpusAccess(): boolean {
  return !isClaudeAiSubscriber() || !isProSubscriber()
}

export function isOverageProvisioningAllowed(): boolean {
  const billingType = getOauthAccountInfo()?.billingType
  if (!billingType) {
    return false
  }
  return ALLOWED_OVERAGE_BILLING_TYPES.has(billingType)
}

/**
 * Returns a human-readable subscription plan name.
 */
export function getSubscriptionName(): string | undefined {
  switch (getSubscriptionType()) {
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    case 'enterprise':
      return 'Claude Enterprise'
    case 'team':
      return 'Claude Team'
    default:
      return undefined
  }
}

/**
 * Summarizes the active account, organization, subscription, and auth sources.
 */
export function getAccountInformation(): AccountInformation {
  const account = getOauthAccountInfo()
  const tokenSource = getAuthTokenSource()
  const apiKeyInfo = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  return {
    ...(account?.emailAddress ? { email: account.emailAddress } : {}),
    ...(account?.organizationName
      ? { organization: account.organizationName }
      : {}),
    ...(getSubscriptionName() ? { subscription: getSubscriptionName() } : {}),
    ...(tokenSource.hasToken ? { tokenSource: tokenSource.source } : {}),
    ...(apiKeyInfo.source !== 'none' ? { apiKeySource: apiKeyInfo.source } : {}),
  }
}

/**
 * Resolves the organization UUID from config or live OAuth profile.
 */
export async function getOrganizationUuid(): Promise<string | undefined> {
  const cached = getOauthAccountInfo()?.organizationUuid
  if (cached) {
    return cached
  }
  if (!hasProfileScope()) {
    return undefined
  }
  const accessToken = getClaudeAiOauthTokens()?.accessToken
  if (!accessToken) {
    return undefined
  }
  const profile = await getOauthProfileFromOauthToken(accessToken)
  return profile?.organization?.uuid
}

/**
 * Hydrates `globalConfig.oauthAccount` from environment overrides or live profile
 * if billing/creation timestamps are absent.
 */
export async function populateOauthAccountInfoIfNeeded(): Promise<void> {
  const envAccountUuid = process.env.COPILOT_CLI_ACCOUNT_UUID
  const envEmail = process.env.COPILOT_CLI_USER_EMAIL
  const envOrgUuid = process.env.COPILOT_CLI_ORGANIZATION_UUID
  if (envAccountUuid && envEmail) {
    const existing = getOauthAccountInfo()
    storeOauthAccountInfo({
      ...existing,
      accountUuid: envAccountUuid,
      emailAddress: envEmail,
      organizationUuid: envOrgUuid ?? existing?.organizationUuid,
    })
  }

  await checkAndRefreshOauthTokenIfNeeded()

  if (!isClaudeAiSubscriber() || !hasProfileScope()) {
    return
  }

  const existing = getOauthAccountInfo()
  if (
    existing?.billingType &&
    existing?.accountCreatedAt &&
    existing?.subscriptionCreatedAt
  ) {
    return
  }

  const accessToken = getClaudeAiOauthTokens()?.accessToken
  if (!accessToken) {
    return
  }

  const profileInfo = await fetchProfileInfo(accessToken)
  if (!profileInfo.rawProfile) {
    return
  }

  storeOauthAccountInfo({
    ...existing,
    accountUuid:
      profileInfo.rawProfile.account.uuid || existing?.accountUuid || '',
    emailAddress:
      profileInfo.rawProfile.account.email || existing?.emailAddress || '',
    organizationUuid:
      profileInfo.rawProfile.organization.uuid ?? existing?.organizationUuid,
    displayName: profileInfo.displayName ?? existing?.displayName,
    hasExtraUsageEnabled: profileInfo.hasExtraUsageEnabled,
    billingType: profileInfo.billingType,
    accountCreatedAt:
      profileInfo.accountCreatedAt ?? existing?.accountCreatedAt,
    subscriptionCreatedAt:
      profileInfo.subscriptionCreatedAt ?? existing?.subscriptionCreatedAt,
  })
}

/**
 * Validates the signed-in organization against `policySettings.forceLoginOrgUUID`
 * by failing closed against the live `/api/oauth/profile` endpoint.
 */
export async function validateForceLoginOrg(): Promise<{
  allowed: boolean
  reason?: string
}> {
  const requiredOrgUuid = getSettingsForSource('policySettings')?.forceLoginOrgUUID
  if (!requiredOrgUuid) {
    return { allowed: true }
  }
  const accessToken = getClaudeAiOauthTokens()?.accessToken
  if (!accessToken) {
    return {
      allowed: false,
      reason: `Organization ${requiredOrgUuid} is required by enterprise policy, but no OAuth token is present.`,
    }
  }
  const profile = await getOauthProfileFromOauthToken(accessToken)
  if (!profile?.organization?.uuid) {
    return {
      allowed: false,
      reason: `Unable to verify organization membership for required policy org ${requiredOrgUuid}.`,
    }
  }
  if (profile.organization.uuid !== requiredOrgUuid) {
    return {
      allowed: false,
      reason: `Signed-in organization ${profile.organization.uuid} does not match required organization ${requiredOrgUuid}.`,
    }
  }
  return { allowed: true }
}

// =============================================================================
// AWS & GCP Cloud Credential Refresh (1h TTL) + OTel Headers Helper
// =============================================================================

function isSettingFromProjectOrLocal(
  key: 'awsAuthRefresh' | 'awsCredentialExport' | 'gcpAuthRefresh' | 'otelHeadersHelper',
): boolean {
  if (
    getSettingsForSource('policySettings')?.[key] ||
    getSettingsForSource('flagSettings')?.[key]
  ) {
    return false
  }
  return Boolean(
    getSettingsForSource('localSettings')?.[key] ||
      getSettingsForSource('projectSettings')?.[key],
  )
}

async function runStreamingAuthRefreshCommand(
  command: string,
  settingKey: 'awsAuthRefresh' | 'gcpAuthRefresh',
): Promise<boolean> {
  if (
    isSettingFromProjectOrLocal(settingKey) &&
    !checkHasTrustDialogAccepted()
  ) {
    logForDebugging(`Refusing to run untrusted ${settingKey} before trust`)
    return false
  }

  const manager = AwsAuthStatusManager.getInstance()
  manager.startAuthentication()
  try {
    const child = execa(command, {
      shell: true,
      timeout: CLOUD_AUTH_REFRESH_TIMEOUT_MS,
      reject: false,
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
        if (line) manager.addOutput(line)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
        if (line) manager.addOutput(line)
      }
    })
    const result = await child
    const ok = result.exitCode === 0
    if (!ok) {
      manager.setError(
        `Command "${settingKey}" exited with code ${result.exitCode ?? -1}`,
      )
    }
    manager.endAuthentication(ok)
    return ok
  } catch (error) {
    manager.setError(error instanceof Error ? error.message : String(error))
    manager.endAuthentication(false)
    return false
  }
}

/**
 * Refreshes AWS credentials via `awsAuthRefresh` and/or `awsCredentialExport`
 * (cached for 1 hour).
 */
export const refreshAndGetAwsCredentials = memoizeWithTtlAsync(
  async (): Promise<AwsCredentials | null> => {
    const settings = getInitialSettings()
    const authRefreshCmd = settings.awsAuthRefresh
    const credExportCmd = settings.awsCredentialExport

    if (authRefreshCmd) {
      const valid = await checkStsCallerIdentity()
      if (!valid) {
        await runStreamingAuthRefreshCommand(authRefreshCmd, 'awsAuthRefresh')
        await clearAwsIniCache()
      }
    }

    if (credExportCmd) {
      if (
        isSettingFromProjectOrLocal('awsCredentialExport') &&
        !checkHasTrustDialogAccepted()
      ) {
        logForDebugging(
          'Refusing to run untrusted awsCredentialExport before trust',
        )
        return null
      }
      try {
        const result = await execa(credExportCmd, {
          shell: true,
          timeout: CLOUD_AUTH_REFRESH_TIMEOUT_MS,
          reject: false,
        })
        if (result.exitCode === 0 && typeof result.stdout === 'string') {
          const parsed = safeParseJson(result.stdout.trim())
          if (isValidAwsStsOutput(parsed)) {
            await clearAwsIniCache()
            return {
              accessKeyId: parsed.Credentials.AccessKeyId,
              secretAccessKey: parsed.Credentials.SecretAccessKey,
              sessionToken: parsed.Credentials.SessionToken,
            }
          }
        }
      } catch (error) {
        logError(error)
      }
    }

    return null
  },
  CLOUD_AUTH_REFRESH_TTL_MS,
)

export function clearAwsCredentialsCache(): void {
  refreshAndGetAwsCredentials.cache.clear()
}

interface GoogleAuthLibraryShape {
  GoogleAuth: new (options?: Record<string, unknown>) => {
    getClient(): Promise<{ getAccessToken(): Promise<{ token?: string | null }> }>
  }
}

async function checkGcpCredentialsValid(): Promise<boolean> {
  try {
    const mod = await importOptionalModule<GoogleAuthLibraryShape>(
      'google-auth-library',
      'GCP Vertex credential checks',
    )
    const auth = new mod.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const tokenResult = await Promise.race([
      auth.getClient().then(client => client.getAccessToken()),
      new Promise<null>(resolve => {
        const timer = setTimeout(() => resolve(null), GCP_CHECK_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
    return Boolean(tokenResult?.token)
  } catch {
    return false
  }
}

/**
 * Validates and refreshes GCP credentials via `gcpAuthRefresh` (cached 1 hour).
 */
export const refreshGcpCredentialsIfNeeded = memoizeWithTtlAsync(
  async (): Promise<boolean> => {
    const gcpRefreshCmd = getInitialSettings().gcpAuthRefresh
    if (!gcpRefreshCmd) {
      return true
    }
    const valid = await checkGcpCredentialsValid()
    if (valid) {
      return true
    }
    return runStreamingAuthRefreshCommand(gcpRefreshCmd, 'gcpAuthRefresh')
  },
  CLOUD_AUTH_REFRESH_TTL_MS,
)

export function clearGcpCredentialsCache(): void {
  refreshGcpCredentialsIfNeeded.cache.clear()
}

export function prefetchAwsCredentialsIfSafe(): void {
  if (!isEnvTruthy(process.env.COPILOT_CLI_USE_BEDROCK)) {
    return
  }
  if (
    (isSettingFromProjectOrLocal('awsAuthRefresh') ||
      isSettingFromProjectOrLocal('awsCredentialExport')) &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void refreshAndGetAwsCredentials()
}

export function prefetchGcpCredentialsIfSafe(): void {
  if (!isEnvTruthy(process.env.COPILOT_CLI_USE_VERTEX)) {
    return
  }
  if (
    isSettingFromProjectOrLocal('gcpAuthRefresh') &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void refreshGcpCredentialsIfNeeded()
}

let cachedOtelHeaders: {
  headers: Record<string, string>
  fetchedAt: number
} | null = null

/**
 * Executes `otelHeadersHelper` with debounce TTL and trust gating, returning
 * validated string header pairs.
 */
export async function getOtelHeadersFromHelper(): Promise<
  Record<string, string>
> {
  const helper = getInitialSettings().otelHeadersHelper
  if (!helper) {
    return {}
  }
  if (
    isSettingFromProjectOrLocal('otelHeadersHelper') &&
    !checkHasTrustDialogAccepted()
  ) {
    return {}
  }

  const rawDebounce = process.env.COPILOT_CLI_OTEL_HEADERS_HELPER_DEBOUNCE_MS
  const parsedDebounce = rawDebounce ? Number(rawDebounce) : NaN
  const debounceMs =
    !Number.isNaN(parsedDebounce) && parsedDebounce >= 0
      ? parsedDebounce
      : DEFAULT_OTEL_HELPER_DEBOUNCE_MS

  if (
    cachedOtelHeaders &&
    Date.now() - cachedOtelHeaders.fetchedAt < debounceMs
  ) {
    return cachedOtelHeaders.headers
  }

  try {
    const result = await execa(helper, {
      shell: true,
      timeout: OTEL_HELPER_TIMEOUT_MS,
      reject: false,
    })
    if (result.exitCode !== 0 || typeof result.stdout !== 'string') {
      return cachedOtelHeaders?.headers ?? {}
    }
    const parsed = safeParseJson(result.stdout.trim())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') {
        headers[k] = v
      }
    }
    cachedOtelHeaders = { headers, fetchedAt: Date.now() }
    return headers
  } catch (error) {
    logError(error)
    return cachedOtelHeaders?.headers ?? {}
  }
}

/**
 * Clears all in-memory authentication caches (used on settings change and tests).
 */
export function clearAllAuthCaches(): void {
  getClaudeAiOauthTokens.cache.clear?.()
  getApiKeyFromConfigOrMacOsKeychain.cache.clear?.()
  clearKeychainCache()
  clearApiKeyHelperCache()
  clearAwsCredentialsCache()
  clearGcpCredentialsCache()
  clearLegacyApiKeyPrefetch()
  cachedOtelHeaders = null
  lastCredentialsFileMtime = null
  setOauthTokenFromFd(null)
  setApiKeyFromFd(null)
  notifyAuthCacheInvalidators()
}

// Wire Phase 1 extension hooks automatically on module load.
registerHttpAuthProvider({
  isClaudeAiSubscriber,
  getOauthAccessToken: () => getClaudeAiOauthTokens()?.accessToken,
  getApiKey: () => getAnthropicApiKey() ?? undefined,
  handleOauth401Error: async failedAccessToken => {
    await handleOauth401Error(failedAccessToken)
  },
})

registerSettingsChangeAuthCacheInvalidator(() => {
  clearApiKeyHelperCache()
  clearAwsCredentialsCache()
  clearGcpCredentialsCache()
  cachedOtelHeaders = null
  getClaudeAiOauthTokens.cache.clear?.()
})
