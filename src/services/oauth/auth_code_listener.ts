/**
 * Ephemeral localhost HTTP listener for receiving OAuth 2.0 authorization code
 * redirects with CSRF state validation and deferred browser redirect.
 */

import * as http from 'http'
import type { AddressInfo } from 'net'
import { getOauthConfig } from '../../constants/oauth.js'

/**
 * Listens on an ephemeral localhost port for OAuth authorization callbacks.
 */
export class AuthCodeListener {
  private readonly server: http.Server
  private readonly callbackPath: string
  private port = 0
  private pendingResponse: http.ServerResponse | null = null

  constructor(callbackPath = '/callback') {
    this.callbackPath = callbackPath
    this.server = http.createServer()
  }

  /**
   * Starts listening on localhost (`port ?? 0` for OS-assigned ephemeral port).
   */
  async start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        const address = this.server.address() as AddressInfo | null
        if (!address) {
          reject(new Error('Failed to determine OAuth listener port.'))
          return
        }
        this.port = address.port
        resolve(this.port)
      }

      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(port ?? 0, 'localhost')
    })
  }

  /**
   * Returns the bound local port number.
   */
  getPort(): number {
    return this.port
  }

  /**
   * Returns true if a browser callback HTTP response is awaiting redirect.
   */
  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

  /**
   * Waits for an incoming authorization callback matching `expectedState`.
   * Holds the HTTP response open until `handleSuccessRedirect` or `handleErrorRedirect`.
   */
  async waitForAuthorization(
    expectedState: string,
    onReady: () => void | Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const handleRequest = (
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ) => {
        const parsedUrl = new URL(
          req.url ?? '/',
          `http://localhost:${this.port}`,
        )
        if (parsedUrl.pathname !== this.callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not found')
          return
        }

        const code = parsedUrl.searchParams.get('code')
        const state = parsedUrl.searchParams.get('state')

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Authorization code not found')
          reject(new Error('No authorization code received'))
          return
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Invalid state parameter')
          reject(new Error('Invalid state parameter'))
          return
        }

        this.pendingResponse = res
        this.server.off('request', handleRequest)
        this.server.off('error', handleError)
        resolve(code)
      }

      const handleError = (error: Error) => {
        this.server.off('request', handleRequest)
        this.server.off('error', handleError)
        reject(error)
      }

      this.server.on('request', handleRequest)
      this.server.once('error', handleError)

      void Promise.resolve(onReady()).catch(error => {
        this.server.off('request', handleRequest)
        this.server.off('error', handleError)
        reject(error)
      })
    })
  }

  /**
   * Completes the pending browser HTTP response with a 302 redirect on success.
   */
  handleSuccessRedirect(
    scopes: string[],
    customHandler?: (
      res: http.ServerResponse,
      scopes: string[],
    ) => void,
  ): void {
    const res = this.pendingResponse
    if (!res) {
      return
    }
    this.pendingResponse = null

    if (customHandler) {
      customHandler(res, scopes)
      return
    }

    const oauthConfig = getOauthConfig()
    const isClaudeAi = scopes.includes('user:inference')
    const redirectUrl = isClaudeAi
      ? oauthConfig.CLAUDEAI_SUCCESS_URL
      : oauthConfig.CONSOLE_SUCCESS_URL
    res.writeHead(302, { Location: redirectUrl })
    res.end()
  }

  /**
   * Completes any pending browser response with an error fallback redirect.
   */
  handleErrorRedirect(): void {
    const res = this.pendingResponse
    if (!res) {
      return
    }
    this.pendingResponse = null
    const oauthConfig = getOauthConfig()
    res.writeHead(302, { Location: oauthConfig.CLAUDEAI_SUCCESS_URL })
    res.end()
  }

  /**
   * Closes the local HTTP server and flushes any dangling browser response.
   */
  close(): void {
    if (this.pendingResponse) {
      this.handleErrorRedirect()
    }
    this.server.removeAllListeners()
    this.server.close()
  }
}
