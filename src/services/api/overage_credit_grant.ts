/**
 * Overage credit grant eligibility cache and USD formatting helper.
 */

import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  getClaudeAiOauthTokens,
  getOauthAccountInfo,
  getOrganizationUuid,
} from '../../utilities/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utilities/config.js'
import { logError } from '../../utilities/log.js'
import { isEssentialTrafficOnly } from '../../utilities/privacy_level.js'

export interface OverageCreditGrantInfo {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

export interface OverageCreditGrantCacheEntry {
  info: OverageCreditGrantInfo
  timestamp: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

async function fetchOverageCreditGrant(): Promise<OverageCreditGrantInfo | null> {
  try {
    const accessToken = getClaudeAiOauthTokens()?.accessToken
    const orgUuid = await getOrganizationUuid()
    if (!accessToken || !orgUuid) {
      return null
    }
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${encodeURIComponent(orgUuid)}/overage_credit_grant`
    const response = await axios.get<OverageCreditGrantInfo>(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      timeout: REQUEST_TIMEOUT_MS,
    })
    return response.data
  } catch (error) {
    logError(error)
    return null
  }
}

/**
 * Returns cached overage credit grant info for the active org if fresh (< 1h).
 */
export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const cached = getGlobalConfig().overageCreditGrantCache?.[orgId]
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
  return cached.info
}

/**
 * Invalidates the cached overage credit grant entry for the active org.
 */
export function invalidateOverageCreditGrantCache(): void {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const cache = getGlobalConfig().overageCreditGrantCache
  if (!cache || !(orgId in cache)) return
  saveGlobalConfig(prev => {
    const next = { ...prev.overageCreditGrantCache }
    delete next[orgId]
    return { ...prev, overageCreditGrantCache: next }
  })
}

/**
 * Fetches and updates the active org's overage credit grant cache.
 */
export async function refreshOverageCreditGrantCache(): Promise<void> {
  if (isEssentialTrafficOnly()) return
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const info = await fetchOverageCreditGrant()
  if (!info) return

  saveGlobalConfig(prev => {
    const prevCached = prev.overageCreditGrantCache?.[orgId]
    const existing = prevCached?.info
    const dataUnchanged =
      existing &&
      existing.available === info.available &&
      existing.eligible === info.eligible &&
      existing.granted === info.granted &&
      existing.amount_minor_units === info.amount_minor_units &&
      existing.currency === info.currency

    if (
      dataUnchanged &&
      prevCached &&
      Date.now() - prevCached.timestamp <= CACHE_TTL_MS
    ) {
      return prev
    }

    const entry: OverageCreditGrantCacheEntry = {
      info: dataUnchanged ? existing : info,
      timestamp: Date.now(),
    }
    return {
      ...prev,
      overageCreditGrantCache: {
        ...prev.overageCreditGrantCache,
        [orgId]: entry,
      },
    }
  })
}

/**
 * Formats a USD grant amount (e.g. `5000` minor units -> `"$50"`).
 */
export function formatGrantAmount(info: OverageCreditGrantInfo): string | null {
  if (info.amount_minor_units == null || !info.currency) return null
  if (info.currency.toUpperCase() === 'USD') {
    const dollars = info.amount_minor_units / 100
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  }
  return null
}
