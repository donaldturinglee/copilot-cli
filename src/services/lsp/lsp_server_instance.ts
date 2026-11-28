/**
 * Stateful `LSPServerInstance` managing a single language server's lifecycle,
 * crash restart budget (up to `maxRestarts ?? 3`), `startupTimeout` /
 * `shutdownTimeout`, and `-32801` (`ContentModified`) exponential backoff retries.
 */

import { basename, resolve } from 'path'
import { pathToFileURL } from 'url'
import { getCwd } from '../../utilities/cwd.js'
import { sleep } from '../../utilities/sleep.js'
import { LSPClient } from './lsp_client.js'
import type {
  LspInitializeParams,
  LspServerState,
  ScopedLspServerConfig,
} from './types.js'

const DEFAULT_MAX_RESTARTS = 3
const MAX_CONTENT_MODIFIED_RETRIES = 3
const CONTENT_MODIFIED_ERROR_CODE = -32801

export class LSPServerInstance {
  state: LspServerState = 'stopped'
  lastError: Error | undefined
  crashRecoveryCount = 0
  restartCount = 0
  startTime: Date | undefined
  readonly client: LSPClient
  private startPromise: Promise<void> | null = null
  private readonly crashListeners: Array<() => void> = []

  constructor(
    readonly name: string,
    readonly config: ScopedLspServerConfig,
  ) {
    this.client = new LSPClient(name, err => {
      this.state = 'error'
      this.lastError = err
      this.crashRecoveryCount++
      for (const listener of this.crashListeners) {
        listener()
      }
    })
  }

  /**
   * Subscribes to unexpected server crashes (used by `LSPServerManager` to
   * invalidate open-document tracking for this server).
   */
  onCrash(listener: () => void): void {
    this.crashListeners.push(listener)
  }

  isHealthy(): boolean {
    return this.state === 'running' && this.client.isInitialized
  }

  /**
   * Starts and initializes the LSP server, enforcing `maxRestarts` (default 3)
   * on repeated crash recovery attempts.
   */
  async start(): Promise<void> {
    if (this.state === 'running' && this.client.isInitialized) {
      return
    }
    if (this.startPromise) {
      return this.startPromise
    }

    const maxRestarts = this.config.maxRestarts ?? DEFAULT_MAX_RESTARTS
    if (this.state === 'error' && this.crashRecoveryCount > maxRestarts) {
      throw new Error(
        `LSP server '${this.name}' exceeded max crash recovery attempts (${maxRestarts})`,
      )
    }

    this.startPromise = (async () => {
      this.state = 'starting'
      const workspaceFolder = resolve(
        this.config.workspaceFolder ?? getCwd(),
      )
      const workspaceUri = pathToFileURL(workspaceFolder).href

      try {
        await this.client.start(this.config.command, this.config.args ?? [], {
          cwd: workspaceFolder,
          env: this.config.env,
          transport: this.config.transport ?? 'stdio',
        })

        const initParams: LspInitializeParams = {
          processId: process.pid,
          initializationOptions: this.config.initializationOptions ?? {},
          rootPath: workspaceFolder,
          rootUri: workspaceUri,
          workspaceFolders: [
            { uri: workspaceUri, name: basename(workspaceFolder) },
          ],
          capabilities: {
            workspace: { configuration: false, workspaceFolders: false },
            textDocument: {
              synchronization: {
                dynamicRegistration: false,
                willSave: false,
                willSaveWaitUntil: false,
                didSave: true,
              },
              publishDiagnostics: {
                relatedInformation: true,
                tagSupport: { valueSet: [1, 2] },
                versionSupport: false,
                codeDescriptionSupport: true,
                dataSupport: false,
              },
              hover: {
                dynamicRegistration: false,
                contentFormat: ['markdown', 'plaintext'],
              },
              definition: { dynamicRegistration: false, linkSupport: true },
              implementation: { dynamicRegistration: false, linkSupport: true },
              references: { dynamicRegistration: false },
              documentSymbol: {
                dynamicRegistration: false,
                hierarchicalDocumentSymbolSupport: true,
              },
              callHierarchy: { dynamicRegistration: false },
            },
            general: { positionEncodings: ['utf-16'] },
          },
        }

        if (this.config.startupTimeout && this.config.startupTimeout > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              this.client.initialize(initParams),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `LSP server '${this.name}' timed out during initialize after ${this.config.startupTimeout}ms`,
                      ),
                    ),
                  this.config.startupTimeout,
                )
                timer.unref?.()
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
        } else {
          await this.client.initialize(initParams)
        }

        this.state = 'running'
        this.startTime = new Date()
        this.lastError = undefined
      } catch (error) {
        this.state = 'error'
        this.lastError =
          error instanceof Error ? error : new Error(String(error))
        await this.client.stop().catch(() => {})
        throw this.lastError
      } finally {
        this.startPromise = null
      }
    })()

    return this.startPromise
  }

  /**
   * Stops the server cleanly, honoring optional `shutdownTimeout`.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return
    }
    this.state = 'stopping'
    try {
      if (this.config.shutdownTimeout && this.config.shutdownTimeout > 0) {
        await Promise.race([
          this.client.stop(),
          sleep(this.config.shutdownTimeout),
        ])
      } else {
        await this.client.stop()
      }
    } finally {
      this.state = 'stopped'
    }
  }

  /**
   * Explicitly restarts the server up to `maxRestarts`.
   */
  async restart(): Promise<void> {
    const maxRestarts = this.config.maxRestarts ?? DEFAULT_MAX_RESTARTS
    this.restartCount++
    if (this.restartCount > maxRestarts) {
      throw new Error(
        `LSP server '${this.name}' exceeded max manual restarts (${maxRestarts})`,
      )
    }
    await this.stop()
    await this.start()
  }

  /**
   * Sends an LSP request with automatic exponential backoff retries (`500ms`,
   * `1000ms`, `2000ms`) on transient `-32801` (`ContentModified`) errors.
   */
  async sendRequest<ResultType = unknown>(
    method: string,
    params?: unknown,
  ): Promise<ResultType> {
    if (!this.isHealthy()) {
      throw new Error(`LSP server '${this.name}' is not running`)
    }

    for (let attempt = 0; attempt <= MAX_CONTENT_MODIFIED_RETRIES; attempt++) {
      try {
        return await this.client.sendRequest<ResultType>(method, params)
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
        if (
          code === CONTENT_MODIFIED_ERROR_CODE &&
          attempt < MAX_CONTENT_MODIFIED_RETRIES
        ) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
        throw error
      }
    }

    throw new Error(`LSP request '${method}' exhausted retries`)
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.isHealthy()) {
      return
    }
    this.client.sendNotification(method, params)
  }
}

export function createLspServerInstance(
  name: string,
  config: ScopedLspServerConfig,
): LSPServerInstance {
  return new LSPServerInstance(name, config)
}
