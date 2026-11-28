/**
 * `LSPServerManager`: routes files by extension to configured language servers,
 * lazily starts servers on first file access, answers `workspace/configuration`,
 * and tracks open document versions across `didOpen` / `didChange` / `didSave` /
 * `didClose`.
 */

import { extname, resolve } from 'path'
import { pathToFileURL } from 'url'
import { getAllLspServers } from './config.js'
import {
  createLspServerInstance,
  type LSPServerInstance,
} from './lsp_server_instance.js'
import type { ScopedLspServerConfig } from './types.js'

export class LSPServerManager {
  readonly servers = new Map<string, LSPServerInstance>()
  private readonly extensionMap = new Map<string, string[]>()
  private readonly openedFiles = new Map<
    string,
    { serverName: string; version: number }
  >()

  /**
   * Registers server configurations without spawning processes eagerly.
   */
  async initialize(
    serversOverride?: Record<string, ScopedLspServerConfig>,
  ): Promise<void> {
    const resolved = serversOverride ?? (await getAllLspServers()).servers
    this.servers.clear()
    this.extensionMap.clear()
    this.openedFiles.clear()

    for (const [name, config] of Object.entries(resolved)) {
      const instance = createLspServerInstance(name, config)
      // Reply with null array to `workspace/configuration` queries (TypeScript/ESLint)
      instance.client.onRequest(
        'workspace/configuration',
        (params: { items?: unknown[] } | undefined) => {
          const items = Array.isArray(params?.items) ? params.items : []
          return items.map(() => this.getServerSettings(config))
        },
      )
      instance.onCrash(() => {
        for (const [uri, doc] of this.openedFiles.entries()) {
          if (doc.serverName === name) {
            this.openedFiles.delete(uri)
          }
        }
      })

      this.servers.set(name, instance)
      for (const ext of Object.keys(config.extensionToLanguage)) {
        const lowerExt = ext.toLowerCase()
        const existing = this.extensionMap.get(lowerExt) ?? []
        existing.push(name)
        this.extensionMap.set(lowerExt, existing)
      }
    }
  }

  private getServerSettings(config: ScopedLspServerConfig): unknown {
    return config.settings ?? null
  }

  getAllServers(): LSPServerInstance[] {
    return Array.from(this.servers.values())
  }

  /**
   * Returns the primary `LSPServerInstance` registered for `filePath`'s extension.
   */
  getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = extname(filePath).toLowerCase()
    if (!ext) {
      return undefined
    }
    const candidates = this.extensionMap.get(ext)
    if (!candidates || candidates.length === 0) {
      return undefined
    }
    return this.servers.get(candidates[0]!)
  }

  /**
   * Ensures the server handling `filePath` is started and initialized.
   */
  async ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    const server = this.getServerForFile(filePath)
    if (!server) {
      return undefined
    }
    if (server.state === 'stopped' || server.state === 'error') {
      await server.start()
    }
    return server
  }

  isFileOpen(filePath: string): boolean {
    const uri = pathToFileURL(resolve(filePath)).href
    const doc = this.openedFiles.get(uri)
    if (!doc) {
      return false
    }
    const server = this.servers.get(doc.serverName)
    return Boolean(server?.isHealthy())
  }

  /**
   * Lazily starts the matching server and sends `textDocument/didOpen`.
   */
  async openFile(filePath: string, content: string): Promise<boolean> {
    const server = await this.ensureServerStarted(filePath)
    if (!server || !server.isHealthy()) {
      return false
    }
    const absPath = resolve(filePath)
    const uri = pathToFileURL(absPath).href
    if (this.openedFiles.get(uri)?.serverName === server.name) {
      return true
    }

    const ext = extname(absPath).toLowerCase()
    const languageMap = Object.fromEntries(
      Object.entries(server.config.extensionToLanguage).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    )
    const languageId = languageMap[ext] ?? 'plaintext'

    server.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    })
    this.openedFiles.set(uri, { serverName: server.name, version: 1 })
    return true
  }

  /**
   * Sends `textDocument/didChange` (or opens the file first if not yet open).
   */
  async changeFile(filePath: string, content: string): Promise<void> {
    const absPath = resolve(filePath)
    const uri = pathToFileURL(absPath).href
    const server = this.getServerForFile(absPath)
    if (!server) {
      return
    }
    const existingDoc = this.openedFiles.get(uri)
    if (!server.isHealthy() || existingDoc?.serverName !== server.name) {
      await this.openFile(absPath, content)
      return
    }

    const nextVersion = existingDoc.version + 1
    existingDoc.version = nextVersion
    server.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: content }],
    })
  }

  /**
   * Sends `textDocument/didSave` if the server for `filePath` is currently running.
   */
  async saveFile(filePath: string, text?: string): Promise<void> {
    const absPath = resolve(filePath)
    const server = this.getServerForFile(absPath)
    if (!server || !server.isHealthy()) {
      return
    }
    const uri = pathToFileURL(absPath).href
    server.sendNotification('textDocument/didSave', {
      textDocument: { uri },
      ...(text !== undefined ? { text } : {}),
    })
  }

  /**
   * Sends `textDocument/didClose` and removes open-document tracking.
   */
  async closeFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath)
    const uri = pathToFileURL(absPath).href
    const server = this.getServerForFile(absPath)
    this.openedFiles.delete(uri)
    if (server?.isHealthy()) {
      server.sendNotification('textDocument/didClose', {
        textDocument: { uri },
      })
    }
  }

  /**
   * Sends a request to the server responsible for `filePath`, lazily starting it
   * if needed.
   */
  async sendRequest<ResultType = unknown>(
    filePath: string,
    method: string,
    params?: unknown,
  ): Promise<ResultType | undefined> {
    const server = await this.ensureServerStarted(filePath)
    if (!server) {
      return undefined
    }
    return server.sendRequest<ResultType>(method, params)
  }

  /**
   * Shuts down all running LSP servers.
   */
  async shutdown(): Promise<void> {
    const all = Array.from(this.servers.values())
    this.servers.clear()
    this.extensionMap.clear()
    this.openedFiles.clear()
    await Promise.allSettled(all.map(s => s.stop()))
  }
}
