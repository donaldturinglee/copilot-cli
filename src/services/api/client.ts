/**
 * Multi-provider Anthropic SDK client factory supporting:
 * - Anthropic 1P (`@anthropic-ai/sdk`)
 * - AWS Bedrock (`@anthropic-ai/bedrock-sdk`, dynamically loaded)
 * - Google Vertex AI (`@anthropic-ai/vertex-sdk`, dynamically loaded)
 * - Azure AI Foundry (`@anthropic-ai/foundry-sdk`, dynamically loaded)
 */

import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import {
  checkAndRefreshOauthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAiOauthTokens,
  isClaudeAiSubscriber,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from '../../utilities/auth.js'
import { randomUUID } from '../../utilities/crypto.js'
import { logForDebugging } from '../../utilities/debug.js'
import {
  getAwsRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utilities/env_utils.js'
import { getUserAgent } from '../../utilities/http.js'
import { getSmallFastModel } from '../../utilities/model/model.js'
import {
  getApiProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utilities/model/providers.js'
import { importOptionalModule } from '../../utilities/optional_import.js'
import { getProxyFetchOptions } from '../../utilities/proxy.js'

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

const DEFAULT_API_TIMEOUT_MS = 600_000

export interface GetAnthropicClientOptions {
  apiKey?: string
  maxRetries?: number
  model?: string
  fetchOverride?: typeof fetch
  source?: string
}

interface BedrockSdkModule {
  AnthropicBedrock: new (options: Record<string, unknown>) => Anthropic
}

interface VertexSdkModule {
  AnthropicVertex: new (options: Record<string, unknown>) => Anthropic
}

interface FoundrySdkModule {
  AnthropicFoundry: new (options: Record<string, unknown>) => Anthropic
}

interface GoogleAuthModule {
  GoogleAuth: new (options?: Record<string, unknown>) => unknown
}

interface AzureIdentityModule {
  DefaultAzureCredential: new () => unknown
  getBearerTokenProvider: (
    credential: unknown,
    scopes: string | string[],
  ) => () => Promise<string>
}

/**
 * Parses newline-delimited `Name: Value` pairs from `ANTHROPIC_CUSTOM_HEADERS`.
 */
export function parseCustomHeaders(
  raw: string | undefined = process.env.ANTHROPIC_CUSTOM_HEADERS,
): Record<string, string> {
  if (!raw) {
    return {}
  }
  const headers: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx <= 0) continue
    const name = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (name) {
      headers[name] = value
    }
  }
  return headers
}

/**
 * Resolves the API request timeout in milliseconds (`API_TIMEOUT_MS` or 10 min).
 */
export function getApiTimeoutMs(): number {
  const raw = process.env.API_TIMEOUT_MS
  if (raw) {
    const parsed = Number(raw)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_API_TIMEOUT_MS
}

function buildWrappedFetch(
  baseFetch: typeof fetch,
  source: string | undefined,
  attachRequestId: boolean,
): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const requestId = randomUUID()
    const headers = new Headers(init?.headers)
    if (attachRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, requestId)
    }

    let pathname = ''
    try {
      const urlString =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      pathname = new URL(urlString).pathname
    } catch {
      pathname = String(input)
    }

    logForDebugging(
      `[API REQUEST] ${pathname} ${CLIENT_REQUEST_ID_HEADER}=${headers.get(CLIENT_REQUEST_ID_HEADER) ?? requestId}${source ? ` source=${source}` : ''}`,
    )

    return baseFetch(input, {
      ...init,
      headers,
    })
  }
  return wrapped as typeof fetch
}

function buildDefaultHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...parseCustomHeaders(),
  }

  if (process.env.COPILOT_CLI_CONTAINER_ID) {
    headers['x-claude-remote-container-id'] =
      process.env.COPILOT_CLI_CONTAINER_ID
  }
  if (process.env.COPILOT_CLI_REMOTE_SESSION_ID) {
    headers['x-claude-remote-session-id'] =
      process.env.COPILOT_CLI_REMOTE_SESSION_ID
  }
  if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    headers['x-client-app'] = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_ADDITIONAL_PROTECTION)) {
    headers['x-anthropic-additional-protection'] = 'true'
  }

  return headers
}

/**
 * Creates a configured Anthropic SDK client for the active provider
 * (`firstParty`, `bedrock`, `vertex`, or `foundry`).
 */
export async function getAnthropicClient(
  options: GetAnthropicClientOptions = {},
): Promise<Anthropic> {
  const { apiKey, maxRetries = 0, model, fetchOverride, source } = options
  const provider = getApiProvider()
  const timeout = getApiTimeoutMs()
  const defaultHeaders = buildDefaultHeaders()
  const fetchOptions = getProxyFetchOptions({ forAnthropicApi: true })

  await checkAndRefreshOauthTokenIfNeeded()

  const isSubscriber = isClaudeAiSubscriber()
  if (!isSubscriber) {
    const bearerToken =
      process.env.ANTHROPIC_AUTH_TOKEN ||
      (await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession()))
    if (bearerToken && !defaultHeaders.Authorization) {
      defaultHeaders.Authorization = `Bearer ${bearerToken}`
    }
  }

  const attachClientRequestId =
    provider === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  const baseFetch = fetchOverride ?? globalThis.fetch
  const customFetch = buildWrappedFetch(
    baseFetch,
    source,
    attachClientRequestId,
  )

  if (provider === 'bedrock') {
    const bedrockMod = await importOptionalModule<BedrockSdkModule>(
      '@anthropic-ai/bedrock-sdk',
      'AWS Bedrock provider',
    )
    const awsRegion =
      model &&
      model === getSmallFastModel() &&
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        : getAwsRegion()

    const bedrockOptions: Record<string, unknown> = {
      awsRegion,
      maxRetries,
      timeout,
      dangerouslyAllowBrowser: true,
      fetch: customFetch,
      fetchOptions,
      defaultHeaders,
      ...(process.env.ANTHROPIC_BEDROCK_BASE_URL
        ? { baseURL: process.env.ANTHROPIC_BEDROCK_BASE_URL }
        : {}),
    }

    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockOptions.skipAuth = true
      defaultHeaders.Authorization = `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`
    } else if (isEnvTruthy(process.env.COPILOT_CLI_SKIP_BEDROCK_AUTH)) {
      bedrockOptions.skipAuth = true
    } else {
      const creds = await refreshAndGetAwsCredentials()
      if (creds) {
        bedrockOptions.awsAccessKey = creds.accessKeyId
        bedrockOptions.awsSecretKey = creds.secretAccessKey
        if (creds.sessionToken) {
          bedrockOptions.awsSessionToken = creds.sessionToken
        }
      }
    }

    return new bedrockMod.AnthropicBedrock(bedrockOptions)
  }

  if (provider === 'foundry') {
    const foundryMod = await importOptionalModule<FoundrySdkModule>(
      '@anthropic-ai/foundry-sdk',
      'Azure AI Foundry provider',
    )
    const foundryApiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY
    const foundryOptions: Record<string, unknown> = {
      maxRetries,
      timeout,
      dangerouslyAllowBrowser: true,
      fetch: customFetch,
      fetchOptions,
      defaultHeaders,
      ...(process.env.ANTHROPIC_FOUNDRY_BASE_URL
        ? { baseURL: process.env.ANTHROPIC_FOUNDRY_BASE_URL }
        : {}),
      ...(process.env.ANTHROPIC_FOUNDRY_RESOURCE
        ? { resource: process.env.ANTHROPIC_FOUNDRY_RESOURCE }
        : {}),
    }

    if (foundryApiKey) {
      foundryOptions.apiKey = foundryApiKey
    } else if (isEnvTruthy(process.env.COPILOT_CLI_SKIP_FOUNDRY_AUTH)) {
      foundryOptions.azureADTokenProvider = async () => ''
    } else {
      const azureMod = await importOptionalModule<AzureIdentityModule>(
        '@azure/identity',
        'Azure AI Foundry Entra ID authentication',
      )
      foundryOptions.azureADTokenProvider = azureMod.getBearerTokenProvider(
        new azureMod.DefaultAzureCredential(),
        'https://cognitiveservices.azure.com/.default',
      )
    }

    return new foundryMod.AnthropicFoundry(foundryOptions)
  }

  if (provider === 'vertex') {
    const skipVertexAuth = isEnvTruthy(process.env.COPILOT_CLI_SKIP_VERTEX_AUTH)
    if (!skipVertexAuth) {
      await refreshGcpCredentialsIfNeeded()
    }
    const [vertexMod, googleAuthMod] = await Promise.all([
      importOptionalModule<VertexSdkModule>(
        '@anthropic-ai/vertex-sdk',
        'Google Vertex AI provider',
      ),
      skipVertexAuth
        ? Promise.resolve(null)
        : importOptionalModule<GoogleAuthModule>(
            'google-auth-library',
            'Google Vertex AI authentication',
          ).catch(() => null),
    ])

    const hasAmbientGcpProjectOrCreds = Boolean(
      process.env.GCLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.gcloud_project ||
        process.env.google_cloud_project ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.google_application_credentials,
    )

    const vertexOptions: Record<string, unknown> = {
      region: getVertexRegionForModel(model),
      maxRetries,
      timeout,
      dangerouslyAllowBrowser: true,
      fetch: customFetch,
      fetchOptions,
      defaultHeaders,
      ...(process.env.ANTHROPIC_VERTEX_BASE_URL
        ? { baseURL: process.env.ANTHROPIC_VERTEX_BASE_URL }
        : {}),
      ...(process.env.ANTHROPIC_VERTEX_PROJECT_ID &&
      !hasAmbientGcpProjectOrCreds
        ? { projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID }
        : {}),
      ...(googleAuthMod
        ? {
            googleAuth: new googleAuthMod.GoogleAuth({
              scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            }),
          }
        : {}),
    }

    return new vertexMod.AnthropicVertex(vertexOptions)
  }

  const resolvedApiKey = isSubscriber
    ? null
    : (apiKey ?? getAnthropicApiKey() ?? null)
  const resolvedAuthToken = isSubscriber
    ? getClaudeAiOauthTokens()?.accessToken
    : undefined

  const clientOptions: ClientOptions = {
    apiKey: resolvedApiKey,
    ...(resolvedAuthToken ? { authToken: resolvedAuthToken } : {}),
    ...(process.env.ANTHROPIC_BASE_URL || process.env.COPILOT_CLI_API_BASE_URL
      ? {
          baseURL:
            process.env.ANTHROPIC_BASE_URL ||
            process.env.COPILOT_CLI_API_BASE_URL,
        }
      : {}),
    maxRetries,
    timeout,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    fetch: customFetch,
    fetchOptions: fetchOptions as ClientOptions['fetchOptions'],
  }

  return new Anthropic(clientOptions)
}
