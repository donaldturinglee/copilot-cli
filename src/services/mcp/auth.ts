/**
 * RFC 9728 / RFC 8414 OAuth 2.0 PKCE + Step-Up + Cross-App Access (XAA)
 * authentication provider, cross-process lockfile refresh, Keychain-safe
 * discovery persistence, and RFC 7009 token revocation for MCP servers.
 */

import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import * as http from 'http'
import { join } from 'path'
import {
  auth as sdkAuth,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  refreshAuthorization as sdkRefreshAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidGrantError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {
  OAuthMetadataSchema,
  type AuthorizationServerMetadata,
  type OAuthClientInformation,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import xss from 'xss'
import { MCP_CLIENT_METADATA_URL } from '../../constants/oauth.js'
import { openBrowser } from '../../utilities/browser.js'
import { logForDebugging } from '../../utilities/debug.js'
import { getClaudeConfigHomeDir } from '../../utilities/env_utils.js'
import * as lockfile from '../../utilities/lockfile.js'
import { getSecureStorage } from '../../utilities/secure_storage/index.js'
import { clearKeychainCache } from '../../utilities/secure_storage/mac_os_keychain_helpers.js'
import type { McpOauthEntry } from '../../utilities/secure_storage/types.js'
import { sleep } from '../../utilities/sleep.js'
import {
  buildRedirectUri,
  DEFAULT_OAUTH_CALLBACK_PORT,
  findAvailablePort,
} from './oauth_port.js'
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpSseServerConfig,
} from './types.js'
import { performCrossAppAccess, XaaTokenExchangeError } from './xaa.js'
import {
  acquireIdpIdToken,
  clearIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  isXaaEnabled,
} from './xaa_idp_login.js'

const REFRESH_BUFFER_MS = 300_000
const CALLBACK_TIMEOUT_MS = 300_000

export type OauthCapableMcpConfig = McpSseServerConfig | McpHttpServerConfig

/**
 * Thrown when an interactive MCP OAuth flow is aborted by the user.
 */
export class AuthenticationCancelledError extends Error {
  constructor(message = 'MCP OAuth authentication cancelled') {
    super(message)
    this.name = 'AuthenticationCancelledError'
  }
}

/**
 * Computes a deterministic SHA-256 key (`<serverName>|<16-hex>`) scoping stored
 * OAuth credentials to a server's URL and static headers.
 */
export function getServerKey(
  serverName: string,
  serverConfig: McpServerConfig,
): string {
  const url = 'url' in serverConfig ? serverConfig.url : ''
  const headers =
    'headers' in serverConfig && serverConfig.headers
      ? Object.entries(serverConfig.headers).sort(([a], [b]) =>
          a.localeCompare(b),
        )
      : []
  const digest = createHash('sha256')
    .update(JSON.stringify({ type: serverConfig.type ?? 'stdio', url, headers }))
    .digest('hex')
    .slice(0, 16)
  return `${serverName}|${digest}`
}

/**
 * Saves an OAuth confidential client secret (and optional `clientId`) for `serverName`.
 */
export function saveMcpClientSecret(
  serverName: string,
  serverConfig: McpServerConfig,
  clientSecret: string,
  clientId?: string,
): void {
  const storage = getSecureStorage()
  const current = storage.read() ?? {}
  const key = getServerKey(serverName, serverConfig)
  storage.update({
    ...current,
    mcpOAuthClientConfig: {
      ...(current.mcpOAuthClientConfig ?? {}),
      [key]: {
        ...(clientId ? { clientId } : {}),
        clientSecret,
      },
    },
  })
}

/**
 * Reads saved OAuth client credentials (`clientId` / `clientSecret`) for a server.
 */
export function getMcpClientConfig(
  serverName: string,
  serverConfig: McpServerConfig,
): { clientId?: string; clientSecret?: string } | undefined {
  const key = getServerKey(serverName, serverConfig)
  return getSecureStorage().read()?.mcpOAuthClientConfig?.[key]
}

/**
 * Clears saved OAuth client config for a server.
 */
export function clearMcpClientConfig(
  serverName: string,
  serverConfig: McpServerConfig,
): void {
  const storage = getSecureStorage()
  const current = storage.read()
  if (!current?.mcpOAuthClientConfig) {
    return
  }
  const next = { ...current.mcpOAuthClientConfig }
  delete next[getServerKey(serverName, serverConfig)]
  storage.update({ ...current, mcpOAuthClientConfig: next })
}

/**
 * Returns true if OAuth discovery state was recorded for this server without an
 * active access token (fast-path `needs-auth` detection).
 */
export function hasMcpDiscoveryButNoToken(
  serverName: string,
  serverConfig: McpServerConfig,
): boolean {
  const entry =
    getSecureStorage().read()?.mcpOAuth?.[getServerKey(serverName, serverConfig)]
  if (!entry) {
    return false
  }
  return Boolean(entry.discoveryState && !entry.accessToken)
}

/**
 * Normalizes non-RFC HTTP 200 error bodies (such as Slack's `{ ok: false, error }`)
 * into standard HTTP 400 OAuth error responses so the MCP SDK triggers re-auth.
 */
export async function normalizeOauthErrorBody(
  response: Response,
): Promise<Response> {
  if (response.status !== 200) {
    return response
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return response
  }
  const cloned = response.clone()
  try {
    const body = (await cloned.json()) as Record<string, unknown>
    const rawErr =
      body.ok === false && typeof body.error === 'string'
        ? body.error
        : typeof body.error === 'string' && !('access_token' in body)
          ? body.error
          : null
    if (!rawErr) {
      return response
    }
    const mappedError =
      rawErr === 'invalid_refresh_token' ||
      rawErr === 'expired_refresh_token' ||
      rawErr === 'token_expired'
        ? 'invalid_grant'
        : rawErr
    return new Response(
      JSON.stringify({
        error: mappedError,
        ...(typeof body.error_description === 'string'
          ? { error_description: body.error_description }
          : {}),
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  } catch {
    return response
  }
}

/**
 * Discovers OAuth Authorization Server metadata via custom `authServerMetadataUrl`,
 * RFC 9728 Protected Resource Metadata, or RFC 8414 / OIDC fallback.
 */
export async function fetchAuthServerMetadata(
  serverUrl: string,
  options?: {
    authServerMetadataUrl?: string
    resourceMetadataUrl?: URL
    fetchFn?: FetchLike
  },
): Promise<AuthorizationServerMetadata | undefined> {
  const fetchFn = options?.fetchFn ?? fetch
  if (options?.authServerMetadataUrl) {
    if (!options.authServerMetadataUrl.startsWith('https://')) {
      throw new Error('authServerMetadataUrl must use https://')
    }
    const res = await fetchFn(options.authServerMetadataUrl, {
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      const parsed = OAuthMetadataSchema.safeParse(await res.json())
      if (parsed.success) {
        return parsed.data
      }
    }
  }

  try {
    const info = await discoverOAuthServerInfo(serverUrl, {
      fetchFn,
      resourceMetadataUrl: options?.resourceMetadataUrl,
    })
    if (info.authorizationServerMetadata) {
      return info.authorizationServerMetadata
    }
  } catch {
    // Fall back to direct authorization server metadata discovery
  }

  return discoverAuthorizationServerMetadata(new URL(serverUrl), { fetchFn })
}

/**
 * Wraps `baseFetch` to detect HTTP 403 `insufficient_scope` challenges and mark
 * step-up scope re-consent on `provider`.
 */
export function wrapFetchWithStepUpDetection(
  baseFetch: FetchLike,
  provider: ClaudeAuthProvider,
): FetchLike {
  return async (url, init) => {
    const res = await baseFetch(url, init)
    if (res.status === 403) {
      const wwwAuth = res.headers.get('www-authenticate') ?? ''
      if (wwwAuth.includes('insufficient_scope')) {
        const scopeMatch = wwwAuth.match(/scope="([^"]+)"/)
        const prmMatch = wwwAuth.match(/resource_metadata="([^"]+)"/)
        provider.markStepUpPending(scopeMatch?.[1], prmMatch?.[1])
      }
    }
    return res
  }
}

function createOauthFetch(baseFetch: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const res = await baseFetch(url, init)
    return normalizeOauthErrorBody(res)
  }
}

function ensureRefreshLockFile(serverKey: string): string {
  const dir = join(getClaudeConfigHomeDir(), 'locks')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const safeName = createHash('sha256').update(serverKey).digest('hex').slice(0, 24)
  const filePath = join(dir, `mcp-oauth-${safeName}.lock`)
  try {
    writeFileSync(filePath, '', { flag: 'wx', mode: 0o600 })
  } catch {
    // Already exists
  }
  return filePath
}

/**
 * MCP SDK `OAuthClientProvider` backed by `SecureStorage` with PKCE, CIMD,
 * 4KB Keychain-safe discovery state, cross-process refresh locking, step-up
 * scope elevation, and silent XAA refresh.
 */
export class ClaudeAuthProvider implements OAuthClientProvider {
  private readonly serverKey: string
  private codeVerifierValue = ''
  private stepUpPending = false
  private redirectPort: number
  private onRedirectHandler?: (authorizationUrl: URL) => void | Promise<void>

  constructor(
    readonly serverName: string,
    readonly serverConfig: OauthCapableMcpConfig,
    options?: {
      redirectPort?: number
      onRedirect?: (authorizationUrl: URL) => void | Promise<void>
    },
  ) {
    this.serverKey = getServerKey(serverName, serverConfig)
    this.redirectPort =
      options?.redirectPort ??
      serverConfig.oauth?.callbackPort ??
      DEFAULT_OAUTH_CALLBACK_PORT
    this.onRedirectHandler = options?.onRedirect
  }

  setRedirectPort(port: number): void {
    this.redirectPort = port
  }

  get redirectUrl(): string {
    return buildRedirectUri(this.redirectPort)
  }

  get clientMetadataUrl(): string | undefined {
    return process.env.MCP_OAUTH_CLIENT_METADATA_URL ?? MCP_CLIENT_METADATA_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    const storedClientCfg = getMcpClientConfig(
      this.serverName,
      this.serverConfig,
    )
    const hasSecret = Boolean(storedClientCfg?.clientSecret)
    return {
      client_name: 'Copilot CLI',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: hasSecret ? 'client_secret_post' : 'none',
    }
  }

  markStepUpPending(scope?: string, resourceMetadataUrl?: string): void {
    this.stepUpPending = true
    const storage = getSecureStorage()
    const current = storage.read() ?? {}
    const existing = current.mcpOAuth?.[this.serverKey]
    if (!existing) {
      return
    }
    storage.update({
      ...current,
      mcpOAuth: {
        ...(current.mcpOAuth ?? {}),
        [this.serverKey]: {
          ...existing,
          ...(scope ? { stepUpScope: scope } : {}),
          ...(resourceMetadataUrl && existing.discoveryState
            ? {
                discoveryState: {
                  ...existing.discoveryState,
                  resourceMetadataUrl,
                },
              }
            : {}),
        },
      },
    })
  }

  clientInformation(): OAuthClientInformation | undefined {
    const data = getSecureStorage().read()
    const entry = data?.mcpOAuth?.[this.serverKey]
    const clientCfg = data?.mcpOAuthClientConfig?.[this.serverKey]
    const clientId =
      this.serverConfig.oauth?.clientId ??
      clientCfg?.clientId ??
      entry?.clientId
    if (!clientId) {
      return undefined
    }
    const clientSecret = clientCfg?.clientSecret ?? entry?.clientSecret
    return {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    const storage = getSecureStorage()
    const current = storage.read() ?? {}
    const existing = current.mcpOAuth?.[this.serverKey]
    const updated: McpOauthEntry = {
      serverName: this.serverName,
      serverUrl: this.serverConfig.url,
      accessToken: existing?.accessToken ?? '',
      expiresAt: existing?.expiresAt ?? 0,
      ...existing,
      clientId: info.client_id,
      ...(info.client_secret ? { clientSecret: info.client_secret } : {}),
    }
    storage.update({
      ...current,
      mcpOAuth: {
        ...(current.mcpOAuth ?? {}),
        [this.serverKey]: updated,
      },
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const storage = getSecureStorage()
    const entry = storage.read()?.mcpOAuth?.[this.serverKey]

    if (this.serverConfig.oauth?.xaa) {
      if (
        entry?.accessToken &&
        entry.expiresAt - Date.now() > REFRESH_BUFFER_MS
      ) {
        return {
          access_token: entry.accessToken,
          token_type: 'Bearer',
          ...(entry.refreshToken ? { refresh_token: entry.refreshToken } : {}),
          ...(entry.scope ? { scope: entry.scope } : {}),
        }
      }
      if (isXaaEnabled()) {
        try {
          return await this.refreshViaXaa()
        } catch (error) {
          logForDebugging(
            `Silent XAA refresh skipped for "${this.serverName}": ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return undefined
    }

    if (!entry?.accessToken) {
      return undefined
    }

    if (this.stepUpPending || entry.stepUpScope) {
      return {
        access_token: entry.accessToken,
        token_type: 'Bearer',
      }
    }

    if (
      entry.expiresAt > 0 &&
      entry.expiresAt - Date.now() <= REFRESH_BUFFER_MS &&
      entry.refreshToken
    ) {
      const refreshed = await this.refreshStoredTokens(entry)
      if (refreshed) {
        return refreshed
      }
    }

    return {
      access_token: entry.accessToken,
      token_type: 'Bearer',
      ...(entry.refreshToken ? { refresh_token: entry.refreshToken } : {}),
      ...(entry.scope ? { scope: entry.scope } : {}),
    }
  }

  private async refreshViaXaa(): Promise<OAuthTokens | undefined> {
    const idp = getXaaIdpSettings()
    if (!idp) {
      return undefined
    }
    const idToken = await acquireIdpIdToken({
      idp,
      skipInteractiveLogin: true,
    })
    const clientInfo = this.clientInformation()
    const tokens = await performCrossAppAccess({
      serverUrl: this.serverConfig.url,
      serverName: this.serverName,
      mcpClientId: clientInfo?.client_id,
      mcpClientSecret: clientInfo?.client_secret,
      idpIssuer: idp.issuer,
      idpClientId: idp.clientId,
      idpClientSecret: getIdpClientSecret(idp.issuer),
      idToken,
    })
    this.saveTokens(tokens)
    return tokens
  }

  private async refreshStoredTokens(
    initialEntry: McpOauthEntry,
  ): Promise<OAuthTokens | undefined> {
    const lockTarget = ensureRefreshLockFile(this.serverKey)
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(lockTarget, { retries: 5 })
      clearKeychainCache()
      const freshEntry = getSecureStorage().read()?.mcpOAuth?.[this.serverKey]
      if (
        freshEntry &&
        freshEntry.expiresAt - Date.now() > REFRESH_BUFFER_MS &&
        freshEntry.accessToken
      ) {
        return {
          access_token: freshEntry.accessToken,
          token_type: 'Bearer',
          ...(freshEntry.refreshToken
            ? { refresh_token: freshEntry.refreshToken }
            : {}),
          ...(freshEntry.scope ? { scope: freshEntry.scope } : {}),
        }
      }

      const targetEntry = freshEntry ?? initialEntry
      if (!targetEntry.refreshToken) {
        return undefined
      }
      const clientInfo = this.clientInformation()
      if (!clientInfo) {
        return undefined
      }

      const authServerUrl =
        targetEntry.discoveryState?.authorizationServerUrl ??
        this.serverConfig.url
      const metadata = await fetchAuthServerMetadata(this.serverConfig.url, {
        authServerMetadataUrl: this.serverConfig.oauth?.authServerMetadataUrl,
        fetchFn: createOauthFetch(),
      })

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const newTokens = await sdkRefreshAuthorization(authServerUrl, {
            metadata,
            clientInformation: clientInfo,
            refreshToken: targetEntry.refreshToken,
            resource: new URL(this.serverConfig.url),
            fetchFn: createOauthFetch(),
          })
          this.saveTokens(newTokens)
          return newTokens
        } catch (error) {
          if (error instanceof InvalidGrantError) {
            this.clearStoredTokens()
            return undefined
          }
          const isTransient =
            error instanceof ServerError ||
            error instanceof TemporarilyUnavailableError ||
            error instanceof TooManyRequestsError
          if (!isTransient || attempt === 2) {
            throw error
          }
          await sleep(1000 * Math.pow(2, attempt))
        }
      }
    } catch (error) {
      logForDebugging(
        `MCP OAuth refresh failed for "${this.serverName}": ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
    } finally {
      if (release) {
        await release().catch(() => {})
      }
    }
    return undefined
  }

  saveTokens(tokens: OAuthTokens): void {
    this.stepUpPending = false
    const storage = getSecureStorage()
    const current = storage.read() ?? {}
    const existing = current.mcpOAuth?.[this.serverKey]
    const expiresInSec = tokens.expires_in ?? 3600
    const nextEntry: McpOauthEntry = {
      ...existing,
      serverName: this.serverName,
      serverUrl: this.serverConfig.url,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? existing?.refreshToken,
      expiresAt: Date.now() + expiresInSec * 1000,
      scope: tokens.scope ?? existing?.scope,
      stepUpScope: undefined,
    }
    storage.update({
      ...current,
      mcpOAuth: {
        ...(current.mcpOAuth ?? {}),
        [this.serverKey]: nextEntry,
      },
    })
  }

  clearStoredTokens(): void {
    const storage = getSecureStorage()
    const current = storage.read()
    if (!current?.mcpOAuth?.[this.serverKey]) {
      return
    }
    const nextMcpOauth = { ...current.mcpOAuth }
    delete nextMcpOauth[this.serverKey]
    storage.update({
      ...current,
      mcpOAuth: nextMcpOauth,
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.onRedirectHandler) {
      await this.onRedirectHandler(authorizationUrl)
      return
    }
    await openBrowser(authorizationUrl.toString())
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    return this.codeVerifierValue
  }

  /**
   * Saves ONLY compact URLs (`authorizationServerUrl`, `resourceMetadataUrl`)
   * so macOS Keychain's 4KB `security -i` stdin buffer is never exceeded.
   */
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const storage = getSecureStorage()
    const current = storage.read() ?? {}
    const existing = current.mcpOAuth?.[this.serverKey]
    const nextEntry: McpOauthEntry = {
      serverName: this.serverName,
      serverUrl: this.serverConfig.url,
      accessToken: existing?.accessToken ?? '',
      expiresAt: existing?.expiresAt ?? 0,
      ...existing,
      discoveryState: {
        authorizationServerUrl: state.authorizationServerUrl,
        ...(state.resourceMetadataUrl
          ? { resourceMetadataUrl: state.resourceMetadataUrl }
          : {}),
      },
    }
    storage.update({
      ...current,
      mcpOAuth: {
        ...(current.mcpOAuth ?? {}),
        [this.serverKey]: nextEntry,
      },
    })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const saved =
      getSecureStorage().read()?.mcpOAuth?.[this.serverKey]?.discoveryState
    if (!saved?.authorizationServerUrl) {
      return undefined
    }
    return {
      authorizationServerUrl: saved.authorizationServerUrl,
      ...(saved.resourceMetadataUrl
        ? { resourceMetadataUrl: saved.resourceMetadataUrl }
        : {}),
    }
  }
}

/**
 * Runs a complete interactive MCP OAuth 2.0 PKCE flow (or XAA flow when
 * `serverConfig.oauth?.xaa` is enabled), supporting both loopback HTTP callback
 * and manual callback URL submission.
 */
export async function performMcpOauthFlow(
  serverName: string,
  serverConfig: OauthCapableMcpConfig,
  onAuthorizationUrl: (url: string) => void,
  abortSignal?: AbortSignal,
  options?: {
    skipBrowserOpen?: boolean
    onWaitingForCallback?: (submitCallbackUrl: (url: string) => void) => void
    fetchFn?: FetchLike
  },
): Promise<void> {
  const fetchFn = createOauthFetch(options?.fetchFn)

  if (serverConfig.oauth?.xaa) {
    if (!isXaaEnabled()) {
      throw new Error(
        `MCP server "${serverName}" requires Cross-App Access (XAA), which is disabled. Set COPILOT_CLI_ENABLE_XAA=1 to enable it.`,
      )
    }
    const idp = getXaaIdpSettings()
    if (!idp) {
      throw new Error(
        `No XAA Identity Provider configured for "${serverName}". Run "copilot mcp xaa setup" first.`,
      )
    }
    const idToken = await acquireIdpIdToken({
      idp,
      onAuthorizationUrl,
      abortSignal,
      skipBrowserOpen: options?.skipBrowserOpen,
      fetchFn,
    })
    const provider = new ClaudeAuthProvider(serverName, serverConfig)
    const clientInfo = provider.clientInformation()
    try {
      const tokens = await performCrossAppAccess({
        serverUrl: serverConfig.url,
        serverName,
        mcpClientId: clientInfo?.client_id,
        mcpClientSecret: clientInfo?.client_secret,
        idpIssuer: idp.issuer,
        idpClientId: idp.clientId,
        idpClientSecret: getIdpClientSecret(idp.issuer),
        idToken,
        abortSignal,
        fetchFn,
      })
      provider.saveTokens(tokens)
      return
    } catch (error) {
      if (error instanceof XaaTokenExchangeError && error.shouldClearIdToken) {
        clearIdpIdToken(idp.issuer)
      }
      throw error
    }
  }

  const port = await findAvailablePort(serverConfig.oauth?.callbackPort)
  let expectedState: string | null = null
  const provider = new ClaudeAuthProvider(serverName, serverConfig, {
    redirectPort: port,
    onRedirect: async authUrl => {
      expectedState = authUrl.searchParams.get('state')
      const urlStr = authUrl.toString()
      onAuthorizationUrl(urlStr)
      if (!options?.skipBrowserOpen) {
        await openBrowser(urlStr)
      }
    },
  })

  const codePromise = new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      server.close()
      fn()
    }

    const handleCallbackUrl = (
      callbackUrl: URL,
      res?: http.ServerResponse,
    ): void => {
      const errParam = callbackUrl.searchParams.get('error')
      if (errParam) {
        const desc =
          callbackUrl.searchParams.get('error_description') ?? errParam
        res
          ?.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<p>MCP authorization failed: ${xss(desc)}</p>`)
        finish(() => reject(new Error(`OAuth authorization failed: ${desc}`)))
        return
      }
      const code = callbackUrl.searchParams.get('code')
      const receivedState = callbackUrl.searchParams.get('state')
      if (!code) {
        res?.writeHead(400).end('Missing authorization code')
        finish(() => reject(new Error('Missing authorization code')))
        return
      }
      if (expectedState && receivedState !== expectedState) {
        res?.writeHead(400).end('Invalid OAuth state parameter')
        finish(() => reject(new Error('OAuth CSRF state mismatch')))
        return
      }
      res
        ?.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<p>Authorization complete! You can return to Copilot CLI.</p>')
      finish(() => resolve(code))
    }

    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (parsed.pathname !== '/callback') {
        res.writeHead(404).end('Not found')
        return
      }
      handleCallbackUrl(parsed, res)
    })

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Timed out waiting for OAuth callback')))
    }, CALLBACK_TIMEOUT_MS)
    timer.unref?.()

    abortSignal?.addEventListener(
      'abort',
      () => {
        finish(() => reject(new AuthenticationCancelledError()))
      },
      { once: true },
    )

    options?.onWaitingForCallback?.((pastedUrl: string) => {
      try {
        handleCallbackUrl(new URL(pastedUrl.trim()))
      } catch (err) {
        finish(() =>
          reject(
            err instanceof Error ? err : new Error('Invalid callback URL'),
          ),
        )
      }
    })

    server.listen(port, '127.0.0.1')
  })

  const initialResult = await sdkAuth(provider, {
    serverUrl: serverConfig.url,
    fetchFn,
  })
  if (initialResult === 'AUTHORIZED') {
    return
  }

  const authorizationCode = await codePromise
  const finalResult = await sdkAuth(provider, {
    serverUrl: serverConfig.url,
    authorizationCode,
    fetchFn,
  })
  if (finalResult !== 'AUTHORIZED') {
    throw new Error(`Unexpected OAuth completion status: ${finalResult}`)
  }
}

export const performMCPOAuthFlow = performMcpOauthFlow

/**
 * Revokes stored refresh and access tokens via RFC 7009 if the authorization
 * server advertises a `revocation_endpoint`, then deletes local credentials.
 */
export async function revokeServerTokens(
  serverName: string,
  serverConfig: OauthCapableMcpConfig,
  fetchFn: FetchLike = fetch,
): Promise<void> {
  const key = getServerKey(serverName, serverConfig)
  const storage = getSecureStorage()
  const entry = storage.read()?.mcpOAuth?.[key]
  if (!entry) {
    return
  }

  try {
    const metadata = await fetchAuthServerMetadata(serverConfig.url, {
      authServerMetadataUrl: serverConfig.oauth?.authServerMetadataUrl,
      fetchFn,
    })
    const rawRevocation = (metadata as Record<string, unknown> | null)
      ?.revocation_endpoint
    const revocationEndpoint = rawRevocation
      ? String(rawRevocation)
      : undefined
    if (revocationEndpoint) {
      const tokensToRevoke = [
        entry.refreshToken
          ? { token: entry.refreshToken, hint: 'refresh_token' }
          : null,
        entry.accessToken
          ? { token: entry.accessToken, hint: 'access_token' }
          : null,
      ].filter(
        (item): item is { token: string; hint: string } => item !== null,
      )
      for (const item of tokensToRevoke) {
        const body = new URLSearchParams({
          token: item.token,
          token_type_hint: item.hint,
          ...(entry.clientId ? { client_id: entry.clientId } : {}),
        })
        await fetchFn(revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }).catch(() => {})
      }
    }
  } catch {
    // Best-effort network revocation; always wipe local storage below
  }

  const provider = new ClaudeAuthProvider(serverName, serverConfig)
  provider.clearStoredTokens()
}
