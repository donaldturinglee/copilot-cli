/**
 * AWS STS credential validation and AWS SDK INI cache helpers for Bedrock.
 */

import { getAwsRegion } from './env_utils.js'
import { importOptionalModule } from './optional_import.js'

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface AwsStsOutput {
  Credentials: {
    AccessKeyId: string
    SecretAccessKey: string
    SessionToken: string
    Expiration?: string
  }
}

interface StsModuleShape {
  STSClient: new (config: { region: string }) => {
    send(command: unknown): Promise<unknown>
  }
  GetCallerIdentityCommand: new (input: Record<string, never>) => unknown
}

interface CredentialProvidersModuleShape {
  fromIni: (options?: { ignoreCache?: boolean }) => () => Promise<unknown>
}

/**
 * Returns true if an error is an AWS SDK `CredentialsProviderError`.
 */
export function isAwsCredentialsProviderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CredentialsProviderError' ||
      error.name === 'ExpiredTokenException')
  )
}

/**
 * Validates that an object matches the AWS STS `Credentials` JSON output contract.
 */
export function isValidAwsStsOutput(value: unknown): value is AwsStsOutput {
  if (!value || typeof value !== 'object' || !('Credentials' in value)) {
    return false
  }
  const creds = (value as { Credentials?: unknown }).Credentials
  if (!creds || typeof creds !== 'object') {
    return false
  }
  const record = creds as Record<string, unknown>
  return (
    typeof record.AccessKeyId === 'string' &&
    record.AccessKeyId.length > 0 &&
    typeof record.SecretAccessKey === 'string' &&
    record.SecretAccessKey.length > 0 &&
    typeof record.SessionToken === 'string' &&
    record.SessionToken.length > 0
  )
}

/**
 * Checks whether ambient AWS credentials are valid via STS `GetCallerIdentity`.
 */
export async function checkStsCallerIdentity(): Promise<boolean> {
  try {
    const stsMod = await importOptionalModule<StsModuleShape>(
      '@aws-sdk/client-sts',
      'AWS Bedrock STS identity checks',
    )
    const client = new stsMod.STSClient({ region: getAwsRegion() })
    await client.send(new stsMod.GetCallerIdentityCommand({}))
    return true
  } catch {
    return false
  }
}

/**
 * Clears the AWS SDK shared INI credential provider cache after auth refresh.
 */
export async function clearAwsIniCache(): Promise<void> {
  try {
    const providersMod =
      await importOptionalModule<CredentialProvidersModuleShape>(
        '@aws-sdk/credential-providers',
        'AWS credential cache refresh',
      )
    await providersMod.fromIni({ ignoreCache: true })()
  } catch {
    // Ignore when optional AWS credential providers package is unavailable
  }
}
