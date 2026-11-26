/**
 * Billing access visibility checks for Console API customers and Claude.ai subscribers.
 */

import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getSubscriptionType,
  isClaudeAiSubscriber,
} from './auth.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './env_utils.js'

let mockBillingAccessOverride: boolean | null = null

/**
 * Overrides Claude.ai billing access checks during mock rate-limit testing.
 */
export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

/**
 * Returns true if the current Console/API user has org/workspace billing visibility.
 */
export function hasConsoleBillingAccess(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }
  if (isClaudeAiSubscriber()) {
    return false
  }
  const authSource = getAuthTokenSource()
  const hasApiKey = getAnthropicApiKey() !== null
  if (!authSource.hasToken && !hasApiKey) {
    return false
  }

  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole
  const workspaceRole = config.oauthAccount?.workspaceRole
  if (!orgRole || !workspaceRole) {
    return false
  }

  return (
    ['admin', 'billing'].includes(orgRole) ||
    ['workspace_admin', 'workspace_billing'].includes(workspaceRole)
  )
}

/**
 * Returns true if the current Claude.ai subscriber has billing access.
 */
export function hasClaudeAiBillingAccess(): boolean {
  if (mockBillingAccessOverride !== null) {
    return mockBillingAccessOverride
  }
  if (!isClaudeAiSubscriber()) {
    return false
  }
  const subscriptionType = getSubscriptionType()
  if (subscriptionType === 'max' || subscriptionType === 'pro') {
    return true
  }
  const orgRole = getGlobalConfig().oauthAccount?.organizationRole
  return (
    Boolean(orgRole) &&
    ['admin', 'billing', 'owner', 'primary_owner'].includes(orgRole!)
  )
}
