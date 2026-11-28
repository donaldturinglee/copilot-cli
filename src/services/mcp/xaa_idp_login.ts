/**
 * OIDC Discovery and IdP `id_token` acquisition for Cross-App Access (XAA / SEP-990).
 */

import * as http from 'http'
import {
  OpenIdProviderDiscoveryMetadataSchema,
  type OpenIdProviderDiscoveryMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import xss from 'xss'
import { generateCodeChallenge, generateCodeVerifier, generateState } from '../oauth/crypto.js'
import { openBrowser } from '../../utilities/browser.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import { getSecureStorage } from '../../utilities/secure_storage/index.js'
import { getInitialSettings } from '../../utilities/settings/settings.js'
import { buildRedirectUri, findAvailablePort } from './oauth_port.js'

export interface XaaIdpSettings {
  issuer: string
  clientId: string
  callbackPort?: number
}

/**
 * Returns true when Cross-App Access (`COPILOT_CLI_ENABLE_XAA` / `CLAUDE_CODE_ENABLE_XAA`)
 * is enabled.
 */
export function isXaaEnabled(): boolean {
  return (
    isEnvTruthy(process.env.COPILOT_CLI_ENABLE_XAA) ||
    isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_XAA)
  )
}

/**
 * Normalizes an OIDC issuer URL to a canonical storage key preserving tenant path segments.
 */
export function issuerKey(issuer: string): string {
  const parsed = new URL(issuer)
  const cleanPath = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${cleanPath}`
}

/**
 * Reads configured `xaaIdp` settings if valid.
 */
export function getXaaIdpSettings(): XaaIdpSettings | null {
  const raw = (getInitialSettings() as Record<string, unknown>).xaaIdp
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.issuer !== 'string' || typeof obj.clientId !== 'string') {
    return null
  }
  return {
    issuer: obj.issuer,
    clientId: obj.clientId,
    ...(typeof obj.callbackPort === 'number'
      ? { callbackPort: obj.callbackPort }
      : {}),
  }
}

/**
 * Discovers OIDC provider metadata at `${issuer}/.well-known/openid-configuration`,
 * preserving multi-tenant path prefixes (Okta, Keycloak, Entra ID).
 */
export async function discoverOidc(
  issuerUrl: string,
  fetchFn: FetchLike = fetch,
): Promise<OpenIdProviderDiscoveryMetadata> {
  const normalizedIssuer = issuerUrl.replace(/\/+$/, '')
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`
  const response = await fetchFn(discoveryUrl, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed at ${discoveryUrl}: HTTP ${response.status}`,
    )
  }
  const json: unknown = await response.json()
  const metadata = OpenIdProviderDiscoveryMetadataSchema.parse(json)
  if (metadata.issuer.replace(/\/+$/, '') !== normalizedIssuer) {
    throw new Error(
      `OIDC issuer mismatch: expected "${normalizedIssuer}", got "${metadata.issuer}"`,
    )
  }
  return metadata
}

function decodeJwtExpMs(jwt: string): number {
  const parts = jwt.split('.')
  if (parts.length < 2 || !parts[1]) {
    return Date.now() + 3600_000
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { exp?: unknown }
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      return payload.exp * 1000
    }
  } catch {
    // Fallback to 1h TTL if non-standard JWT payload
  }
  return Date.now() + 3600_000
}

/**
 * Saves an IdP `id_token` into `SecureStorageData.mcpXaaIdp`.
 */
export function saveIdpIdTokenFromJwt(issuer: string, idToken: string): void {
  const storage = getSecureStorage()
  const current = storage.read() ?? {}
  const key = issuerKey(issuer)
  storage.update({
    ...current,
    mcpXaaIdp: {
      ...(current.mcpXaaIdp ?? {}),
      [key]: {
        idToken,
        expiresAt: decodeJwtExpMs(idToken),
      },
    },
  })
}

/**
 * Returns the cached IdP `id_token` status for `issuer`.
 */
export function getCachedIdpIdTokenStatus(issuer: string): {
  present: boolean
  expiresAt?: number
  expired?: boolean
} {
  const entry = getSecureStorage().read()?.mcpXaaIdp?.[issuerKey(issuer)]
  if (!entry) {
    return { present: false }
  }
  return {
    present: true,
    expiresAt: entry.expiresAt,
    expired: entry.expiresAt - Date.now() <= 60_000,
  }
}

/**
 * Clears any cached IdP `id_token` for `issuer`.
 */
export function clearIdpIdToken(issuer: string): void {
  const storage = getSecureStorage()
  const current = storage.read()
  if (!current?.mcpXaaIdp) {
    return
  }
  const next = { ...current.mcpXaaIdp }
  delete next[issuerKey(issuer)]
  storage.update({ ...current, mcpXaaIdp: next })
}

/**
 * Stores an IdP confidential client secret in `SecureStorageData.mcpXaaIdpConfig`.
 */
export function saveIdpClientSecret(issuer: string, clientSecret: string): void {
  const storage = getSecureStorage()
  const current = storage.read() ?? {}
  storage.update({
    ...current,
    mcpXaaIdpConfig: {
      ...(current.mcpXaaIdpConfig ?? {}),
      [issuerKey(issuer)]: { clientSecret },
    },
  })
}

/**
 * Reads an IdP client secret from secure storage.
 */
export function getIdpClientSecret(issuer: string): string | undefined {
  return getSecureStorage().read()?.mcpXaaIdpConfig?.[issuerKey(issuer)]
    ?.clientSecret
}

/**
 * Removes a stored IdP client secret from secure storage.
 */
export function clearIdpClientSecret(issuer: string): void {
  const storage = getSecureStorage()
  const current = storage.read()
  if (!current?.mcpXaaIdpConfig) {
    return
  }
  const next = { ...current.mcpXaaIdpConfig }
  delete next[issuerKey(issuer)]
  storage.update({ ...current, mcpXaaIdpConfig: next })
}

/**
 * Acquires a valid OIDC `id_token` for `idp`, reusing the cached token when
 * >60s from expiry or running an OIDC Authorization Code + PKCE loopback login.
 */
export async function acquireIdpIdToken(params: {
  idp: XaaIdpSettings
  clientSecret?: string
  onAuthorizationUrl?: (url: string) => void
  abortSignal?: AbortSignal
  skipInteractiveLogin?: boolean
  skipBrowserOpen?: boolean
  fetchFn?: FetchLike
}): Promise<string> {
  const key = issuerKey(params.idp.issuer)
  const cached = getSecureStorage().read()?.mcpXaaIdp?.[key]
  if (cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.idToken
  }
  if (params.skipInteractiveLogin) {
    throw new Error(
      `Cached IdP id_token for ${params.idp.issuer} is missing or expired. Run "copilot mcp xaa login" to authenticate.`,
    )
  }

  const fetchFn = params.fetchFn ?? fetch
  const oidc = await discoverOidc(params.idp.issuer, fetchFn)
  const port = await findAvailablePort(params.idp.callbackPort)
  const redirectUri = buildRedirectUri(port)
  const verifier = generateCodeVerifier()
  const challenge = generateCodeChallenge(verifier)
  const state = generateState()

  const authUrl = new URL(oidc.authorization_endpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', params.idp.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', 'openid profile email')
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found')
        return
      }
      const errParam = url.searchParams.get('error')
      if (errParam) {
        const desc = url.searchParams.get('error_description') ?? errParam
        res
          .writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<p>Authentication failed: ${xss(desc)}</p>`)
        server.close()
        reject(new Error(`IdP OAuth error: ${desc}`))
        return
      }
      const receivedState = url.searchParams.get('state')
      const receivedCode = url.searchParams.get('code')
      if (receivedState !== state || !receivedCode) {
        res.writeHead(400).end('Invalid OAuth callback parameters')
        server.close()
        reject(new Error('Invalid state or missing code in IdP callback'))
        return
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<p>IdP login complete. You may close this window.</p>')
      server.close()
      resolve(receivedCode)
    })

    const onAbort = () => {
      server.close()
      reject(new Error('IdP login cancelled'))
    }
    params.abortSignal?.addEventListener('abort', onAbort, { once: true })

    server.listen(port, '127.0.0.1', () => {
      const authUrlStr = authUrl.toString()
      params.onAuthorizationUrl?.(authUrlStr)
      if (!params.skipBrowserOpen) {
        void openBrowser(authUrlStr)
      }
    })
  })

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: params.idp.clientId,
    code_verifier: verifier,
  })
  const secret = params.clientSecret ?? getIdpClientSecret(params.idp.issuer)
  if (secret) {
    body.set('client_secret', secret)
  }

  const tokenRes = await fetchFn(oidc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!tokenRes.ok) {
    throw new Error(`IdP token exchange failed: HTTP ${tokenRes.status}`)
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: unknown }
  if (typeof tokenJson.id_token !== 'string' || !tokenJson.id_token) {
    throw new Error('IdP token response did not include an id_token')
  }

  saveIdpIdTokenFromJwt(params.idp.issuer, tokenJson.id_token)
  return tokenJson.id_token
}
