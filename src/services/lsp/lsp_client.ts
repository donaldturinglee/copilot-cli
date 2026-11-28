/**
 * Native JSON-RPC 2.0 `Content-Length` framed LSP client supporting both
 * `stdio` (`child_process.spawn`) and `socket` (`net.Socket`) transports,
 * spawn-barrier error handling, deferred pre-start handler registration, and
 * `initialize`/`initialized`/`shutdown`/`exit` lifecycle management.
 */

import { spawn, type ChildProcess } from 'child_process'
import * as net from 'net'
import type { Readable, Writable } from 'stream'
import { logForDebugging } from '../../utilities/debug.js'
import { subprocessEnv } from '../../utilities/subprocess_env.js'
import type { LspInitializeParams, LspInitializeResult } from './types.js'

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export class LspRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(err: JsonRpcErrorObject) {
    super(err.message)
    this.name = 'LspRpcError'
    this.code = err.code
    this.data = err.data
  }
}

type NotificationHandler = (params: unknown) => void
type RequestHandler = (params: unknown) => unknown | Promise<unknown>

interface PendingRpcRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

function parseSocketPortFromArgs(args: readonly string[] = []): {
  host: string
  port: number
} {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      const p = Number(args[i + 1])
      if (Number.isInteger(p) && p > 0) {
        return { host: '127.0.0.1', port: p }
      }
    }
    const eqMatch = arg.match(/^--port=(\d+)$/)
    if (eqMatch?.[1]) {
      return { host: '127.0.0.1', port: Number(eqMatch[1]) }
    }
  }
  return { host: '127.0.0.1', port: 2087 }
}

/**
 * Low-level LSP JSON-RPC 2.0 client.
 */
export class LSPClient {
  isInitialized = false
  capabilities: Record<string, unknown> | undefined

  private childProcess: ChildProcess | null = null
  private socket: net.Socket | null = null
  private readable: Readable | null = null
  private writable: Writable | null = null
  private inboundBuffer: Buffer = Buffer.alloc(0)
  private nextRequestId = 1
  private isStopping = false
  private readonly pendingRequests = new Map<number, PendingRpcRequest>()
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler[]
  >()
  private readonly requestHandlers = new Map<string, RequestHandler>()

  constructor(
    readonly serverName: string,
    private readonly onCrash?: (error: Error) => void,
  ) {}

  /**
   * Registers a server-to-client notification listener (may be called before `start()`).
   */
  onNotification<ParamsType = unknown>(
    method: string,
    handler: (params: ParamsType) => void,
  ): void {
    const existing = this.notificationHandlers.get(method) ?? []
    existing.push(handler as NotificationHandler)
    this.notificationHandlers.set(method, existing)
  }

  /**
   * Registers a server-to-client request listener (e.g. `workspace/configuration`).
   */
  onRequest<ParamsType = unknown, ResultType = unknown>(
    method: string,
    handler: (params: ParamsType) => ResultType | Promise<ResultType>,
  ): void {
    this.requestHandlers.set(method, handler as RequestHandler)
  }

  /**
   * Spawns the language server process (or connects over TCP when `transport === 'socket'`)
   * and attaches the `Content-Length` JSON-RPC framing loop.
   */
  async start(
    command: string,
    args: readonly string[] = [],
    options?: {
      cwd?: string
      env?: Record<string, string>
      transport?: 'stdio' | 'socket'
    },
  ): Promise<void> {
    this.isStopping = false
    this.inboundBuffer = Buffer.alloc(0)

    if (options?.transport === 'socket') {
      const { host, port } = parseSocketPortFromArgs(args)
      const sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ host, port })
        s.once('connect', () => resolve(s))
        s.once('error', err => reject(err))
      })
      this.socket = sock
      this.attachStreams(sock, sock)
      sock.on('close', hadError => {
        this.rejectAllPending(new Error(`LSP socket closed for ${this.serverName}`))
        if (hadError && !this.isStopping) {
          this.isInitialized = false
          this.onCrash?.(new Error(`LSP socket crashed for ${this.serverName}`))
        }
      })
      return
    }

    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: {
        ...subprocessEnv(),
        ...(options?.env ?? {}),
      } as NodeJS.ProcessEnv,
      windowsHide: true,
    })

    // Await `'spawn'` vs `'error'` barrier before attaching JSON-RPC pipes
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onErr)
        resolve()
      }
      const onErr = (err: Error) => {
        child.off('spawn', onSpawn)
        reject(err)
      }
      child.once('spawn', onSpawn)
      child.once('error', onErr)
    })

    this.childProcess = child
    child.stdin.on('error', err => {
      logForDebugging(`[LSP ${this.serverName}] stdin error: ${err.message}`)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      logForDebugging(
        `[LSP SERVER ${this.serverName}] ${chunk.toString('utf8').trimEnd()}`,
      )
    })
    child.on('exit', (code, signal) => {
      this.rejectAllPending(
        new Error(
          `LSP server "${this.serverName}" exited (code=${String(code)}, signal=${String(signal)})`,
        ),
      )
      if (!this.isStopping && code !== 0 && code !== null) {
        this.isInitialized = false
        this.onCrash?.(
          new Error(
            `LSP server ${this.serverName} crashed with exit code ${code}`,
          ),
        )
      } else if (!this.isStopping && signal) {
        this.isInitialized = false
        this.onCrash?.(
          new Error(
            `LSP server ${this.serverName} terminated with signal ${signal}`,
          ),
        )
      }
    })

    this.attachStreams(child.stdout, child.stdin)
  }

  private attachStreams(readable: Readable, writable: Writable): void {
    this.readable = readable
    this.writable = writable
    readable.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      this.inboundBuffer =
        this.inboundBuffer.length === 0
          ? buf
          : Buffer.concat([this.inboundBuffer, buf])
      this.drainFrames()
    })
  }

  private writePayload(payload: Record<string, unknown>): void {
    if (!this.writable || this.writable.destroyed) {
      throw new Error(`LSP transport for "${this.serverName}" is not writable`)
    }
    const json = JSON.stringify(payload)
    const byteLength = Buffer.byteLength(json, 'utf8')
    this.writable.write(`Content-Length: ${byteLength}\r\n\r\n${json}`, 'utf8')
  }

  private drainFrames(): void {
    while (true) {
      const headerEnd = this.inboundBuffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }
      const headerText = this.inboundBuffer
        .subarray(0, headerEnd)
        .toString('ascii')
      const lenMatch = headerText.match(/content-length:\s*(\d+)/i)
      if (!lenMatch || !lenMatch[1]) {
        // Malformed frame header: discard past separator
        this.inboundBuffer = this.inboundBuffer.subarray(headerEnd + 4)
        continue
      }
      const contentLength = Number(lenMatch[1])
      const bodyStart = headerEnd + 4
      if (this.inboundBuffer.length < bodyStart + contentLength) {
        return
      }
      const jsonStr = this.inboundBuffer
        .subarray(bodyStart, bodyStart + contentLength)
        .toString('utf8')
      this.inboundBuffer = this.inboundBuffer.subarray(bodyStart + contentLength)

      try {
        const msg = JSON.parse(jsonStr) as Record<string, unknown>
        void this.dispatchMessage(msg)
      } catch (error) {
        logForDebugging(
          `[LSP ${this.serverName}] Invalid JSON-RPC payload: ${String(error)}`,
        )
      }
    }
  }

  private async dispatchMessage(msg: Record<string, unknown>): Promise<void> {
    // Response to client request
    if ('id' in msg && !('method' in msg)) {
      const id = Number(msg.id)
      const pending = this.pendingRequests.get(id)
      if (!pending) {
        return
      }
      this.pendingRequests.delete(id)
      if (msg.error && typeof msg.error === 'object') {
        pending.reject(new LspRpcError(msg.error as JsonRpcErrorObject))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    // Server -> Client Request
    if ('id' in msg && typeof msg.method === 'string') {
      const handler = this.requestHandlers.get(msg.method)
      if (!handler) {
        this.writePayload({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        })
        return
      }
      try {
        const res = await handler(msg.params)
        this.writePayload({
          jsonrpc: '2.0',
          id: msg.id,
          result: res ?? null,
        })
      } catch (error) {
        this.writePayload({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
      return
    }

    // Server -> Client Notification
    if (typeof msg.method === 'string') {
      const handlers = this.notificationHandlers.get(msg.method)
      if (!handlers) return
      for (const handler of handlers) {
        try {
          handler(msg.params)
        } catch (error) {
          logForDebugging(
            `[LSP ${this.serverName}] Notification handler error on ${msg.method}: ${String(error)}`,
          )
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  /**
   * Sends a JSON-RPC request and awaits its typed result.
   */
  sendRequest<ResultType = unknown>(
    method: string,
    params?: unknown,
  ): Promise<ResultType> {
    const id = this.nextRequestId++
    return new Promise<ResultType>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: val => resolve(val as ResultType),
        reject,
      })
      try {
        this.writePayload({
          jsonrpc: '2.0',
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        })
      } catch (error) {
        this.pendingRequests.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Sends a one-way JSON-RPC notification.
   */
  sendNotification(method: string, params?: unknown): void {
    this.writePayload({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    })
  }

  /**
   * Performs the LSP `initialize` -> `initialized` handshake.
   */
  async initialize(params: LspInitializeParams): Promise<LspInitializeResult> {
    const result = await this.sendRequest<LspInitializeResult>(
      'initialize',
      params,
    )
    this.capabilities = result?.capabilities ?? {}
    this.sendNotification('initialized', {})
    this.isInitialized = true
    return result
  }

  /**
   * Cleanly shuts down the language server (`shutdown` -> `exit` -> process kill).
   */
  async stop(): Promise<void> {
    this.isStopping = true
    try {
      if (this.isInitialized && this.writable && !this.writable.destroyed) {
        await Promise.race([
          this.sendRequest('shutdown', null),
          new Promise(resolve => setTimeout(resolve, 1_500)),
        ]).catch(() => {})
        try {
          this.sendNotification('exit')
        } catch {
          // Ignore write errors after shutdown
        }
      }
    } finally {
      this.rejectAllPending(new Error('LSP client stopped'))
      this.readable?.removeAllListeners()
      this.socket?.destroy()
      this.socket = null
      if (this.childProcess) {
        this.childProcess.removeAllListeners()
        this.childProcess.stdout?.removeAllListeners()
        this.childProcess.stderr?.removeAllListeners()
        try {
          this.childProcess.kill()
        } catch {
          // Ignore already-dead process
        }
        this.childProcess = null
      }
      this.readable = null
      this.writable = null
      this.isInitialized = false
      this.capabilities = undefined
      this.isStopping = false
    }
  }
}
