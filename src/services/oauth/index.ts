/**
 * High-level OAuth 2.0 PKCE interactive login orchestrator supporting automatic
 * localhost `/callback` capture raced against manual copy-paste code input.
 */

import { openBrowser } from '../../utilities/browser.js'
import { AuthCodeListener } from './auth_code_listener.js'
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchProfileInfo,
  parseScopes,
} from './client.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from './crypto.js'
import type { OauthTokens } from './types.js'

export interface StartOauthFlowOptions {
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  orgUuid?: string
  loginHint?: string
  loginMethod?: string
  skipBrowserOpen?: boolean
  expiresIn?: number
}

export interface ManualAuthCodeInput {
  authorizationCode: string
  state: string
}

/**
 * Coordinates an OAuth 2.0 PKCE login session from verifier generation through
 * token exchange and browser redirect completion.
 */
export class OauthService {
  private readonly codeVerifier: string
  private listener: AuthCodeListener | null = null
  private expectedState: string | null = null
  private manualAuthCodeResolver:
    | ((input: ManualAuthCodeInput) => void)
    | null = null

  constructor() {
    this.codeVerifier = generateCodeVerifier()
  }

  /**
   * Resolves an in-progress OAuth flow via manually pasted authorization code + state.
   */
  handleManualAuthCodeInput(input: ManualAuthCodeInput): void {
    if (this.manualAuthCodeResolver) {
      const resolver = this.manualAuthCodeResolver
      this.manualAuthCodeResolver = null
      resolver(input)
    }
  }

  /**
   * Executes the full OAuth 2.0 PKCE flow.
   */
  async startOauthFlow(
    authUrlHandler: (manualUrl: string, automaticUrl?: string) => void,
    options: StartOauthFlowOptions = {},
  ): Promise<OauthTokens> {
    const listener = new AuthCodeListener('/callback')
    this.listener = listener

    try {
      const port = await listener.start()
      const codeChallenge = generateCodeChallenge(this.codeVerifier)
      const state = generateState()
      this.expectedState = state

      const manualFlowUrl = buildAuthUrl({
        codeChallenge,
        state,
        port,
        isManual: true,
        loginWithClaudeAi: options.loginWithClaudeAi,
        inferenceOnly: options.inferenceOnly,
        orgUuid: options.orgUuid,
        loginHint: options.loginHint,
        loginMethod: options.loginMethod,
      })

      const automaticFlowUrl = buildAuthUrl({
        codeChallenge,
        state,
        port,
        isManual: false,
        loginWithClaudeAi: options.loginWithClaudeAi,
        inferenceOnly: options.inferenceOnly,
        orgUuid: options.orgUuid,
        loginHint: options.loginHint,
        loginMethod: options.loginMethod,
      })

      const manualPromise = new Promise<{
        code: string
        useManualRedirect: boolean
      }>((resolve, reject) => {
        this.manualAuthCodeResolver = ({
          authorizationCode,
          state: receivedState,
        }) => {
          if (receivedState !== state) {
            reject(new Error('Invalid state parameter'))
            return
          }
          resolve({ code: authorizationCode, useManualRedirect: true })
        }
      })

      const automaticPromise = listener
        .waitForAuthorization(state, async () => {
          if (options.skipBrowserOpen) {
            authUrlHandler(manualFlowUrl, automaticFlowUrl)
          } else {
            authUrlHandler(manualFlowUrl)
            await openBrowser(automaticFlowUrl)
          }
        })
        .then(code => ({ code, useManualRedirect: false }))

      const { code, useManualRedirect } = await Promise.race([
        automaticPromise,
        manualPromise,
      ])

      const tokenResponse = await exchangeCodeForTokens(
        code,
        state,
        this.codeVerifier,
        port,
        useManualRedirect,
        options.expiresIn,
      )

      const scopes = parseScopes(tokenResponse.scope)
      const expiresAt = Date.now() + tokenResponse.expires_in * 1000
      const profileInfo = await fetchProfileInfo(tokenResponse.access_token)

      if (!useManualRedirect && listener.hasPendingResponse()) {
        listener.handleSuccessRedirect(scopes)
      }

      return {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token || null,
        expiresAt,
        scopes,
        subscriptionType: profileInfo.subscriptionType,
        rateLimitTier: profileInfo.rateLimitTier,
        profile: profileInfo.rawProfile,
        ...(tokenResponse.account
          ? {
              tokenAccount: {
                uuid: tokenResponse.account.uuid,
                emailAddress: tokenResponse.account.email_address,
                organizationUuid: tokenResponse.organization?.uuid,
              },
            }
          : {}),
      }
    } catch (error) {
      if (this.listener?.hasPendingResponse()) {
        this.listener.handleErrorRedirect()
      }
      throw error
    } finally {
      this.cleanup()
    }
  }

  /**
   * Releases the local callback server and clears pending resolvers.
   */
  cleanup(): void {
    this.manualAuthCodeResolver = null
    this.expectedState = null
    if (this.listener) {
      this.listener.close()
      this.listener = null
    }
  }
}
