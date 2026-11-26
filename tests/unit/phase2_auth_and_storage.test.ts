import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import axios from 'axios'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests } from '../../src/bootstrap/state.js'
import { AuthCodeListener } from '../../src/services/oauth/auth_code_listener.js'
import { isOauthTokenExpired } from '../../src/services/oauth/client.js'
import {
  base64UrlEncode,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../../src/services/oauth/crypto.js'
import {
  checkAndRefreshOauthTokenIfNeeded,
  clearAllAuthCaches,
  getAnthropicApiKeyWithSource,
  getClaudeAiOauthTokens,
  logout,
  saveOauthTokensIfNeeded,
} from '../../src/utilities/auth.js'
import { normalizeApiKeyForConfig } from '../../src/utilities/auth_portable.js'
import { isValidAwsStsOutput } from '../../src/utilities/aws.js'
import { AwsAuthStatusManager } from '../../src/utilities/aws_auth_status_manager.js'
import { getGlobalConfig, saveGlobalConfig } from '../../src/utilities/config.js'
import {
  getPrivacyLevel,
  isEssentialTrafficOnly,
  isTelemetryDisabled,
} from '../../src/utilities/privacy_level.js'
import {
  partiallySanitizeUnicode,
  recursivelySanitizeUnicode,
} from '../../src/utilities/sanitization.js'
import { createFallbackStorage } from '../../src/utilities/secure_storage/fallback_storage.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  keychainCacheState,
  primeKeychainCacheFromPrefetch,
} from '../../src/utilities/secure_storage/mac_os_keychain_helpers.js'
import {
  buildKeychainStdinCommand,
  SECURITY_STDIN_LINE_LIMIT,
} from '../../src/utilities/secure_storage/mac_os_keychain_storage.js'
import {
  getPlainTextCredentialsPath,
  plainTextStorage,
} from '../../src/utilities/secure_storage/plain_text_storage.js'
import type {
  SecureStorage,
  SecureStorageData,
} from '../../src/utilities/secure_storage/types.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

const SAVED_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'COPILOT_CLI_OAUTH_TOKEN',
  'COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'COPILOT_CLI_SIMPLE',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tempDir = ''
let originalAxiosAdapter: typeof axios.defaults.adapter

beforeEach(() => {
  savedEnv = {}
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tempDir = mkdtempSync(join(tmpdir(), 'copilot-phase2-auth-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  originalAxiosAdapter = axios.defaults.adapter
  resetStateForTests()
  resetSettingsCache()
  clearAllAuthCaches()
  clearKeychainCache()
  AwsAuthStatusManager.reset()
})

afterEach(() => {
  axios.defaults.adapter = originalAxiosAdapter
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  resetStateForTests()
  resetSettingsCache()
  clearAllAuthCaches()
  clearKeychainCache()
  AwsAuthStatusManager.reset()
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('Step 2.1 — Auth, OAuth 2.0 PKCE, and Secure Credential Storage', () => {
  test('resolves ANTHROPIC_API_KEY from environment with approval suffix normalization', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    process.env.ANTHROPIC_API_KEY = key

    expect(normalizeApiKeyForConfig(key)).toBe(key.slice(-20))
    const resolved = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    expect(resolved.key).toBe(key)
    expect(resolved.source).toBe('ANTHROPIC_API_KEY')
  })

  test('plainTextStorage persists credentials under CLAUDE_CONFIG_DIR with 0600 permissions', () => {
    const credsPath = getPlainTextCredentialsPath()
    expect(credsPath).toBe(join(tempDir, '.credentials.json'))

    const payload: SecureStorageData = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test-access',
        refreshToken: 'sk-ant-ort01-test-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
    }

    const res = plainTextStorage.update(payload)
    expect(res.success).toBe(true)
    expect(existsSync(credsPath)).toBe(true)

    if (process.platform !== 'win32') {
      const mode = statSync(credsPath).mode & 0o777
      expect(mode).toBe(0o600)
    }

    const readBack = plainTextStorage.read()
    expect(readBack?.claudeAiOauth?.accessToken).toBe(
      'sk-ant-oat01-test-access',
    )
    expect(plainTextStorage.delete()).toBe(true)
    expect(existsSync(credsPath)).toBe(false)
  })

  test('createFallbackStorage migrates to primary and cleans shadow tokens on failure', () => {
    let primaryData: SecureStorageData | null = null
    let secondaryData: SecureStorageData | null = {
      claudeAiOauth: {
        accessToken: 'stale-secondary',
        refreshToken: 'ref',
        expiresAt: 100,
        scopes: ['user:inference'],
        subscriptionType: null,
        rateLimitTier: null,
      },
    }
    let primaryShouldFail = false
    let primaryDeletedCount = 0
    let secondaryDeletedCount = 0

    const makeMock = (isPrimary: boolean): SecureStorage => ({
      name: isPrimary ? 'primary' : 'secondary',
      read: () => (isPrimary ? primaryData : secondaryData),
      readAsync: async () => (isPrimary ? primaryData : secondaryData),
      update: data => {
        if (isPrimary && primaryShouldFail) {
          return { success: false }
        }
        if (isPrimary) {
          primaryData = data
        } else {
          secondaryData = data
        }
        return { success: true }
      },
      delete: () => {
        if (isPrimary) {
          primaryDeletedCount++
          primaryData = null
        } else {
          secondaryDeletedCount++
          secondaryData = null
        }
        return true
      },
    })

    const storage = createFallbackStorage(makeMock(true), makeMock(false))

    // Initial migration: primary empty -> write succeeds -> removes stale secondary
    const freshData: SecureStorageData = {
      claudeAiOauth: {
        accessToken: 'fresh-primary',
        refreshToken: 'ref2',
        expiresAt: 200,
        scopes: ['user:inference'],
        subscriptionType: 'pro',
        rateLimitTier: null,
      },
    }
    expect(storage.update(freshData).success).toBe(true)
    expect(secondaryDeletedCount).toBe(1)
    expect(storage.read()?.claudeAiOauth?.accessToken).toBe('fresh-primary')

    // Shadow-token prevention: primary fails while holding old data -> fallback
    // writes to secondary and deletes stale primary so reads see fresh token
    primaryShouldFail = true
    const newerData: SecureStorageData = {
      claudeAiOauth: {
        accessToken: 'fresh-secondary',
        refreshToken: 'ref3',
        expiresAt: 300,
        scopes: ['user:inference'],
        subscriptionType: 'pro',
        rateLimitTier: null,
      },
    }
    expect(storage.update(newerData).success).toBe(true)
    expect(primaryDeletedCount).toBe(1)
    expect(primaryData).toBeNull()
    expect(storage.read()?.claudeAiOauth?.accessToken).toBe('fresh-secondary')
  })

  test('macOS Keychain helpers format stdin command, scope by config dir hash, and prime cache', () => {
    const cmd = buildKeychainStdinCommand('alice', 'Claude Code-credentials', '7b7d')
    expect(cmd).toBe(
      'add-generic-password -U -a "alice" -s "Claude Code-credentials" -X "7b7d"\n',
    )
    expect(SECURITY_STDIN_LINE_LIMIT).toBe(4032)

    const svcName = getMacOsKeychainStorageServiceName('-credentials')
    expect(svcName).toMatch(/^Claude Code.*-credentials-[0-9a-f]{8}$/)

    primeKeychainCacheFromPrefetch(
      JSON.stringify({ mcpOAuth: {} } satisfies SecureStorageData),
    )
    expect(keychainCacheState.cache.cachedAt).toBeGreaterThan(0)
    expect(keychainCacheState.cache.data).toEqual({ mcpOAuth: {} })

    clearKeychainCache()
    expect(keychainCacheState.cache.cachedAt).toBe(0)
  })

  test('OAuth 2.0 PKCE S256 verifier/challenge matches RFC 7636 test vector', () => {
    // RFC 7636 Appendix B test vector
    const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    expect(generateCodeChallenge(rfcVerifier)).toBe(expectedChallenge)

    const verifier = generateCodeVerifier()
    const state = generateState()
    expect(verifier.length).toBe(43)
    expect(state.length).toBe(43)
    expect(base64UrlEncode(Buffer.from([0xfb, 0xff]))).not.toMatch(/[+/=]/)
  })

  test('AuthCodeListener handles ephemeral localhost /callback, CSRF validation, and 302 redirect', async () => {
    const listener = new AuthCodeListener('/callback')
    try {
      const port = await listener.start(0)
      expect(port).toBeGreaterThan(0)

      // Valid code + matching state resolves and holds response for redirect;
      // wrong path hits 404 while listener is awaiting authorization.
      const expectedState = generateState()
      let notFoundStatus = 0
      let fetchPromise: Promise<Response> | null = null
      const code = await listener.waitForAuthorization(
        expectedState,
        async () => {
          const notFoundRes = await fetch(`http://localhost:${port}/other`)
          notFoundStatus = notFoundRes.status
          fetchPromise = fetch(
            `http://localhost:${port}/callback?code=auth-code-123&state=${expectedState}`,
            { redirect: 'manual' },
          )
        },
      )
      expect(notFoundStatus).toBe(404)
      expect(code).toBe('auth-code-123')
      expect(listener.hasPendingResponse()).toBe(true)

      listener.handleSuccessRedirect(['user:inference'])
      const callbackRes = await fetchPromise!
      expect(callbackRes.status).toBe(302)
      expect(callbackRes.headers.get('location')).toBeTruthy()
    } finally {
      listener.close()
    }
  })

  test('OAuth token storage, expiration check, lockfile refresh, and logout cleanup', async () => {
    const expiredAt = Date.now() - 60_000
    expect(isOauthTokenExpired(expiredAt)).toBe(true)
    expect(isOauthTokenExpired(Date.now() + 60 * 60 * 1000)).toBe(false)

    saveOauthTokensIfNeeded({
      accessToken: 'sk-ant-oat01-expired',
      refreshToken: 'sk-ant-ort01-old-refresh',
      expiresAt: expiredAt,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    })
    saveGlobalConfig(prev => ({
      ...prev,
      oauthAccount: {
        accountUuid: 'acc-1',
        emailAddress: 'dev@example.com',
        organizationUuid: 'org-1',
        billingType: 'stripe_subscription',
        accountCreatedAt: '2025-01-01T00:00:00Z',
        subscriptionCreatedAt: '2025-01-01T00:00:00Z',
      },
    }))

    expect(getClaudeAiOauthTokens()?.accessToken).toBe('sk-ant-oat01-expired')

    // Mock axios adapter for OAuth token refresh endpoint
    let refreshCalls = 0
    axios.defaults.adapter = async config => {
      refreshCalls++
      return {
        data: {
          access_token: 'sk-ant-oat01-refreshed-token',
          refresh_token: 'sk-ant-ort01-new-refresh',
          expires_in: 7200,
          scope: 'user:inference user:profile',
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    }

    const refreshed = await checkAndRefreshOauthTokenIfNeeded()
    expect(refreshed).toBe(true)
    expect(refreshCalls).toBe(1)
    expect(getClaudeAiOauthTokens()?.accessToken).toBe(
      'sk-ant-oat01-refreshed-token',
    )

    // Verify logout cleans credentials file and oauthAccount from global config
    await logout()
    expect(getClaudeAiOauthTokens()).toBeNull()
    expect(getGlobalConfig().oauthAccount).toBeUndefined()
    if (existsSync(getPlainTextCredentialsPath())) {
      const raw = JSON.parse(
        readFileSync(getPlainTextCredentialsPath(), 'utf-8'),
      ) as SecureStorageData
      expect(raw.claudeAiOauth).toBeUndefined()
    }
  })

  test('privacy level, unicode sanitization, AWS STS validation, and AwsAuthStatusManager', () => {
    expect(getPrivacyLevel()).toBe('default')
    expect(isTelemetryDisabled()).toBe(false)
    expect(isEssentialTrafficOnly()).toBe(false)

    process.env.DISABLE_TELEMETRY = '1'
    expect(getPrivacyLevel()).toBe('no-telemetry')
    expect(isTelemetryDisabled()).toBe(true)
    expect(isEssentialTrafficOnly()).toBe(false)

    process.env.COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    expect(getPrivacyLevel()).toBe('essential-traffic')
    expect(isEssentialTrafficOnly()).toBe(true)

    const dirty = 'hello\u200B\u202Eworld\uFEFF'
    expect(partiallySanitizeUnicode(dirty)).toBe('helloworld')
    const dirtyObj: Record<string, unknown> = { ['k\u200Bey']: ['a\u200Db', 42] }
    expect(recursivelySanitizeUnicode(dirtyObj)).toEqual({
      key: ['ab', 42],
    })

    expect(
      isValidAwsStsOutput({
        Credentials: {
          AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          SessionToken: 'IQoJb3JpZ2luX2VjECQ',
        },
      }),
    ).toBe(true)
    expect(isValidAwsStsOutput({ invalid: true })).toBe(false)

    const mgr = AwsAuthStatusManager.getInstance()
    const seen: boolean[] = []
    const unsub = mgr.subscribe(s => seen.push(s.isAuthenticating))
    mgr.startAuthentication()
    mgr.addOutput('Authenticating SSO...')
    expect(mgr.getStatus().output).toEqual(['Authenticating SSO...'])
    mgr.endAuthentication(true)
    unsub()
    expect(seen).toEqual([true, true, false])
    expect(mgr.getStatus().output).toEqual([])
  })
})
