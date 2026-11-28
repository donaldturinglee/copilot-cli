/**
 * SEP-990 Cross-App Access (XAA) 4-step non-interactive token exchange:
 * 1. RFC 9728 Protected Resource Metadata discovery
 * 2. RFC 8414 / OIDC Authorization Server discovery
 * 3. RFC 8693 Token Exchange at IdP (`id_token` -> `id-jag` assertion)
 * 4. RFC 7523 JWT Bearer Grant at MCP Authorization Server (`id-jag` -> `OAuthTokens`)
 */

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  OAuthTokensSchema,
  type AuthorizationServerMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { discoverOidc } from './xaa_idp_login.js'

const GRANT_TYPE_TOKEN_exchange =
  'urn:ietf:params:oauth:grant-type:token-exchange'
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token'
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag'
const GRANT_TYPE_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/**
 * Structured error thrown when XAA token exchange fails, indicating whether the
 * cached IdP `id_token` was rejected (HTTP 4xx) and should be cleared.
 */
export class XaaTokenExchangeError extends Error {
  constructor(
    message: string,
    readonly shouldClearIdToken: boolean,
  ) {
    super(message)
    this.name = 'XaaTokenExchangeError'
  }
}

export interface PerformCrossAppAccessParams {
  serverUrl: string
  serverName: string
  mcpClientId?: string
  mcpClientSecret?: string
  idpIssuer: string
  idpClientId: string
  idpClientSecret?: string
  idToken: string
  abortSignal?: AbortSignal
  fetchFn?: FetchLike
}

async function discoverAsMetadata(
  asIssuer: string,
  fetchFn: FetchLike,
): Promise<AuthorizationServerMetadata> {
  const metadata = await discoverAuthorizationServerMetadata(asIssuer, {
    fetchFn,
  })
  if (!metadata) {
    throw new XaaTokenExchangeError(
      `Authorization server metadata not found for ${asIssuer}`,
      false,
    )
  }
  const tokenUrl = String(metadata.token_endpoint)
  if (
    !tokenUrl.startsWith('https://') &&
    !tokenUrl.startsWith('http://localhost:') &&
    !tokenUrl.startsWith('http://127.0.0.1:')
  ) {
    throw new XaaTokenExchangeError(
      `Insecure MCP authorization server token_endpoint: ${tokenUrl}`,
      false,
    )
  }
  return metadata
}

/**
 * Performs the 4-step SEP-990 Cross-App Access exchange returning MCP `OAuthTokens`.
 */
export async function performCrossAppAccess(
  params: PerformCrossAppAccessParams,
): Promise<OAuthTokens> {
  const fetchFn = params.fetchFn ?? fetch

  // Step 1: RFC 9728 Protected Resource Metadata
  const prm = await discoverOAuthProtectedResourceMetadata(
    params.serverUrl,
    undefined,
    fetchFn,
  )
  const asIssuers = prm.authorization_servers ?? []
  const asIssuer = asIssuers[0]
  if (!asIssuer) {
    throw new XaaTokenExchangeError(
      `MCP server "${params.serverName}" Protected Resource Metadata did not advertise an authorization_server`,
      false,
    )
  }

  // Step 2: Discover MCP Authorization Server & IdP OIDC metadata
  const [asMetadata, idpMetadata] = await Promise.all([
    discoverAsMetadata(asIssuer, fetchFn),
    discoverOidc(params.idpIssuer, fetchFn),
  ])

  // Step 3: RFC 8693 Token Exchange at IdP (id_token -> id-jag)
  const jagBody = new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_exchange,
    subject_token: params.idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience: String(asMetadata.issuer ?? asIssuer),
    resource: String(prm.resource ?? params.serverUrl),
    client_id: params.idpClientId,
  })
  if (params.idpClientSecret) {
    jagBody.set('client_secret', params.idpClientSecret)
  }

  const jagRes = await fetchFn(idpMetadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: jagBody.toString(),
    signal: params.abortSignal,
  })
  if (!jagRes.ok) {
    const isClientErr = jagRes.status >= 400 && jagRes.status < 500
    throw new XaaTokenExchangeError(
      `XAA RFC 8693 IdP token exchange failed with HTTP ${jagRes.status}`,
      isClientErr,
    )
  }
  const jagJson = (await jagRes.json()) as { access_token?: unknown }
  if (typeof jagJson.access_token !== 'string' || !jagJson.access_token) {
    throw new XaaTokenExchangeError(
      'IdP RFC 8693 response missing access_token (id-jag)',
      false,
    )
  }

  // Step 4: RFC 7523 JWT Bearer Grant at MCP Authorization Server
  const bearerBody = new URLSearchParams({
    grant_type: GRANT_TYPE_JWT_BEARER,
    assertion: jagJson.access_token,
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  const supportedAuth = asMetadata.token_endpoint_auth_methods_supported ?? []
  const preferPost =
    supportedAuth.includes('client_secret_post') &&
    !supportedAuth.includes('client_secret_basic')

  if (params.mcpClientId && params.mcpClientSecret && !preferPost) {
    const encoded = Buffer.from(
      `${encodeURIComponent(params.mcpClientId)}:${encodeURIComponent(params.mcpClientSecret)}`,
      'utf8',
    ).toString('base64')
    headers.Authorization = `Basic ${encoded}`
  } else {
    if (params.mcpClientId) {
      bearerBody.set('client_id', params.mcpClientId)
    }
    if (params.mcpClientSecret) {
      bearerBody.set('client_secret', params.mcpClientSecret)
    }
  }

  const mcpTokenRes = await fetchFn(String(asMetadata.token_endpoint), {
    method: 'POST',
    headers,
    body: bearerBody.toString(),
    signal: params.abortSignal,
  })
  if (!mcpTokenRes.ok) {
    throw new XaaTokenExchangeError(
      `XAA RFC 7523 MCP JWT bearer grant failed with HTTP ${mcpTokenRes.status}`,
      false,
    )
  }
  const rawTokens: unknown = await mcpTokenRes.json()
  return OAuthTokensSchema.parse(rawTokens)
}
