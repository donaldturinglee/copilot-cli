/**
 * User identity, GrowthBook attribute derivation, and Git email lookup.
 */

import memoize from 'lodash-es/memoize.js'
import { getSessionId } from '../bootstrap/state.js'
import {
  getApiBaseUrlHost,
  type GrowthBookUserAttributes,
} from '../services/analytics/growthbook.js'
import type { CoreUserData, GitHubActionsMetadata } from '../types/forward.js'
import {
  getOauthAccountInfo,
  getRateLimitTier,
  getSubscriptionType,
} from './auth.js'
import { getGlobalConfig, getOrCreateUserId } from './config.js'
import { getHostPlatformForAnalytics } from './env.js'
import { isEnvTruthy } from './env_utils.js'
import { execFileNoThrow } from './exec_file_no_throw.js'

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

function getGithubActionsMetadata(): GitHubActionsMetadata | undefined {
  if (!isEnvTruthy(process.env.GITHUB_ACTIONS)) {
    return undefined
  }
  const actorId = process.env.GITHUB_ACTOR_ID
  const repositoryId = process.env.GITHUB_REPOSITORY_ID
  const repositoryOwnerId = process.env.GITHUB_REPOSITORY_OWNER_ID
  if (!actorId && !repositoryId && !repositoryOwnerId) {
    return undefined
  }
  return {
    ...(actorId ? { actorId } : {}),
    ...(repositoryId ? { repositoryId } : {}),
    ...(repositoryOwnerId ? { repositoryOwnerId } : {}),
  }
}

/**
 * Returns core user identity metadata used across analytics and telemetry.
 */
export const getCoreUserData = memoize(
  (includeAnalyticsMetadata = true): CoreUserData => {
    const config = getGlobalConfig()
    const account = getOauthAccountInfo()
    const subscriptionType = getSubscriptionType()
    const rateLimitTier = getRateLimitTier()
    const firstTokenTime = config.claudeCodeFirstTokenDate
      ? Date.parse(config.claudeCodeFirstTokenDate)
      : undefined
    const githubActionsMetadata = includeAnalyticsMetadata
      ? getGithubActionsMetadata()
      : undefined

    return {
      deviceId: getOrCreateUserId(),
      sessionId: getSessionId(),
      platform: getHostPlatformForAnalytics(),
      ...(account?.organizationUuid
        ? { organizationUuid: account.organizationUuid }
        : {}),
      ...(account?.accountUuid ? { accountUuid: account.accountUuid } : {}),
      ...(process.env.USER_TYPE ? { userType: process.env.USER_TYPE } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(rateLimitTier ? { rateLimitTier } : {}),
      ...(firstTokenTime && !Number.isNaN(firstTokenTime)
        ? { firstTokenTime }
        : {}),
      ...(account?.emailAddress ? { email: account.emailAddress } : {}),
      appVersion: getMacroVersion(),
      ...(githubActionsMetadata ? { githubActionsMetadata } : {}),
    }
  },
  (includeAnalyticsMetadata = true) => String(includeAnalyticsMetadata),
)

/**
 * Builds GrowthBook feature evaluation attributes for the active user.
 */
export function getUserForGrowthBook(): GrowthBookUserAttributes {
  const core = getCoreUserData(true)
  const apiBaseUrlHost = getApiBaseUrlHost()
  return {
    id: core.accountUuid || core.deviceId,
    sessionId: core.sessionId,
    deviceId: core.deviceId,
    platform: core.platform,
    ...(apiBaseUrlHost ? { apiBaseUrlHost } : {}),
    ...(core.organizationUuid
      ? { organizationUuid: core.organizationUuid }
      : {}),
    ...(core.accountUuid ? { accountUuid: core.accountUuid } : {}),
    ...(core.userType ? { userType: core.userType } : {}),
    ...(core.subscriptionType
      ? { subscriptionType: core.subscriptionType }
      : {}),
    ...(core.rateLimitTier ? { rateLimitTier: core.rateLimitTier } : {}),
    ...(core.firstTokenTime !== undefined
      ? { firstTokenTime: core.firstTokenTime }
      : {}),
    ...(core.email ? { email: core.email } : {}),
    ...(core.appVersion ? { appVersion: core.appVersion } : {}),
    ...(core.githubActionsMetadata
      ? { github: core.githubActionsMetadata }
      : {}),
  }
}

/**
 * Ensures the persistent anonymous device/user ID exists in global config.
 */
export function initUser(): string {
  return getOrCreateUserId()
}

/**
 * Clears memoized user identity caches (used on login/logout and tests).
 */
export function resetUserCache(): void {
  getCoreUserData.cache.clear?.()
  getGitEmail.cache.clear?.()
}

/**
 * Reads the configured `git config --get user.email` (memoized per process).
 */
export const getGitEmail = memoize(async (): Promise<string | undefined> => {
  const result = await execFileNoThrow('git', ['config', '--get', 'user.email'])
  if (result.code === 0) {
    const trimmed = result.stdout.trim()
    return trimmed || undefined
  }
  return undefined
})
