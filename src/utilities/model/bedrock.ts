/**
 * AWS Bedrock inference profile discovery, backing model resolution, and region
 * prefix helpers. Uses dynamic optional imports for `@aws-sdk/*` and `@smithy/*`.
 */

import memoize from 'lodash-es/memoize.js'
import { refreshAndGetAwsCredentials } from '../auth.js'
import { getAwsRegion, isEnvTruthy } from '../env_utils.js'
import { logError } from '../log.js'
import { importOptionalModule } from '../optional_import.js'
import { getAwsClientProxyConfig } from '../proxy.js'

export const BEDROCK_REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const

export type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number]

interface BedrockClientModule {
  BedrockClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>
  }
  ListInferenceProfilesCommand: new (input: Record<string, unknown>) => unknown
  GetInferenceProfileCommand: new (input: Record<string, unknown>) => unknown
}

interface BedrockRuntimeModule {
  BedrockRuntimeClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>
  }
}

interface SmithyCoreModule {
  NoAuthSigner: new () => unknown
}

interface SmithyNodeHttpModule {
  NodeHttpHandler: new (config?: Record<string, unknown>) => unknown
}

async function buildBedrockClientConfig(
  regionOverride?: string,
): Promise<Record<string, unknown>> {
  const region = regionOverride ?? getAwsRegion()
  const endpoint = process.env.ANTHROPIC_BEDROCK_BASE_URL
  const proxyConfig = await getAwsClientProxyConfig()
  const skipAuth = isEnvTruthy(process.env.COPILOT_CLI_SKIP_BEDROCK_AUTH)

  const config: Record<string, unknown> = {
    region,
    ...(endpoint ? { endpoint } : {}),
    ...proxyConfig,
  }

  if (skipAuth) {
    try {
      const [smithyCore, smithyHttp] = await Promise.all([
        importOptionalModule<SmithyCoreModule>(
          '@smithy/core',
          'Bedrock no-auth signing',
        ),
        importOptionalModule<SmithyNodeHttpModule>(
          '@smithy/node-http-handler',
          'Bedrock HTTP/1.1 transport',
        ),
      ])
      config.httpAuthSchemes = [
        {
          schemeId: 'smithy.api#noAuth',
          identityProvider: () => async () => ({}),
          signer: new smithyCore.NoAuthSigner(),
        },
      ]
      config.httpAuthSchemeProvider = () => [{ schemeId: 'smithy.api#noAuth' }]
      config.requestHandler = new smithyHttp.NodeHttpHandler()
    } catch {
      // Optional smithy packages unavailable
    }
    return config
  }

  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    const creds = await refreshAndGetAwsCredentials()
    if (creds) {
      config.credentials = creds
    }
  }
  return config
}

/**
 * Instantiates an AWS Bedrock control-plane client.
 */
export async function createBedrockClient(
  regionOverride?: string,
): Promise<{ send(command: unknown): Promise<Record<string, unknown>> }> {
  const [bedrockMod, config] = await Promise.all([
    importOptionalModule<BedrockClientModule>(
      '@aws-sdk/client-bedrock',
      'AWS Bedrock inference profile discovery',
    ),
    buildBedrockClientConfig(regionOverride),
  ])
  return new bedrockMod.BedrockClient(config)
}

/**
 * Instantiates an AWS Bedrock Runtime client (used e.g. for `CountTokensCommand`).
 */
export async function createBedrockRuntimeClient(
  regionOverride?: string,
): Promise<{ send(command: unknown): Promise<Record<string, unknown>> }> {
  const [runtimeMod, config] = await Promise.all([
    importOptionalModule<BedrockRuntimeModule>(
      '@aws-sdk/client-bedrock-runtime',
      'AWS Bedrock runtime operations',
    ),
    buildBedrockClientConfig(regionOverride),
  ])
  return new runtimeMod.BedrockRuntimeClient(config)
}

/**
 * Paginates system-defined Anthropic Bedrock inference profiles.
 */
export const getBedrockInferenceProfiles = memoize(
  async (): Promise<string[]> => {
    try {
      const [bedrockMod, client] = await Promise.all([
        importOptionalModule<BedrockClientModule>(
          '@aws-sdk/client-bedrock',
          'AWS Bedrock inference profiles',
        ),
        createBedrockClient(),
      ])
      const profiles: string[] = []
      let nextToken: string | undefined
      do {
        const response = await client.send(
          new bedrockMod.ListInferenceProfilesCommand({
            typeEquals: 'SYSTEM_DEFINED',
            ...(nextToken ? { nextToken } : {}),
          }),
        )
        const summaries =
          (response.inferenceProfileSummaries as
            | Array<{ inferenceProfileId?: string }>
            | undefined) ?? []
        for (const summary of summaries) {
          if (summary.inferenceProfileId?.includes('anthropic')) {
            profiles.push(summary.inferenceProfileId)
          }
        }
        nextToken = response.nextToken as string | undefined
      } while (nextToken)
      return profiles
    } catch (error) {
      logError(error)
      return []
    }
  },
)

/**
 * Resolves the backing foundation model ID for a Bedrock inference profile ARN/ID.
 */
export const getInferenceProfileBackingModel = memoize(
  async (profileId: string): Promise<string | null> => {
    try {
      const [bedrockMod, client] = await Promise.all([
        importOptionalModule<BedrockClientModule>(
          '@aws-sdk/client-bedrock',
          'AWS Bedrock inference profile lookup',
        ),
        createBedrockClient(),
      ])
      const response = await client.send(
        new bedrockMod.GetInferenceProfileCommand({
          inferenceProfileIdentifier: profileId,
        }),
      )
      const models =
        (response.models as Array<{ modelArn?: string }> | undefined) ?? []
      const firstArn = models[0]?.modelArn
      if (!firstArn) {
        return null
      }
      return extractModelIdFromArn(firstArn)
    } catch {
      return null
    }
  },
)

/**
 * Returns true if a Bedrock model identifier is a direct foundation model ID.
 */
export function isFoundationModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.')
}

/**
 * Extracts the trailing model ID from an AWS Bedrock ARN, or returns input as-is.
 */
export function extractModelIdFromArn(modelIdOrArn: string): string {
  const slashIdx = modelIdOrArn.lastIndexOf('/')
  return slashIdx >= 0 ? modelIdOrArn.slice(slashIdx + 1) : modelIdOrArn
}

/**
 * Extracts a cross-region Bedrock prefix (`us`, `eu`, `apac`, `global`) if present.
 */
export function getBedrockRegionPrefix(
  modelId: string,
): BedrockRegionPrefix | undefined {
  for (const prefix of BEDROCK_REGION_PREFIXES) {
    if (modelId.startsWith(`${prefix}.`)) {
      return prefix
    }
  }
  return undefined
}

/**
 * Replaces or prepends a Bedrock cross-region prefix on a model ID.
 */
export function applyBedrockRegionPrefix(
  modelId: string,
  prefix: BedrockRegionPrefix,
): string {
  const existing = getBedrockRegionPrefix(modelId)
  if (existing) {
    return `${prefix}.${modelId.slice(existing.length + 1)}`
  }
  if (isFoundationModel(modelId)) {
    return `${prefix}.${modelId}`
  }
  return modelId
}
