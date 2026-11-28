/**
 * Dual-runtime (Bun `globalThis.WebSocket` and Node `ws`) MCP WebSocket
 * transport supporting `ws` and `ws-ide` servers with pre-start message
 * buffering.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener?: (
    type: string,
    listener: (event: unknown) => void,
  ) => void
  on?: (type: string, listener: (...args: unknown[]) => void) => void
}

const WS_OPEN = 1
const WS_CLOSED = 3

function extractMessageText(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8')
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8')
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString(
      'utf8',
    )
  }
  if (raw && typeof raw === 'object' && 'data' in raw) {
    return extractMessageText((raw as { data: unknown }).data)
  }
  return String(raw)
}

/**
 * MCP `Transport` implementation backed by a WebSocket connection.
 */
export class WebSocketTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  private started = false
  private closed = false
  private readonly bufferedMessages: JSONRPCMessage[] = []
  private readonly openedPromise: Promise<void>

  constructor(private readonly socket: WebSocketLike) {
    this.openedPromise = new Promise<void>((resolve, reject) => {
      if (socket.readyState === WS_OPEN) {
        resolve()
        return
      }
      if (socket.readyState >= WS_CLOSED) {
        reject(new Error('WebSocket closed before opening'))
        return
      }

      const onOpen = () => {
        resolve()
      }
      const onInitialError = (err: unknown) => {
        const error =
          err instanceof Error
            ? err
            : new Error(
                err && typeof err === 'object' && 'message' in err
                  ? String((err as { message: unknown }).message)
                  : 'WebSocket connection failed',
              )
        reject(error)
      }

      if (typeof socket.on === 'function') {
        socket.on('open', onOpen)
        socket.on('error', onInitialError)
      } else if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onInitialError)
      }
    })

    const handleMessage = (raw: unknown) => {
      try {
        const text = extractMessageText(raw)
        const parsed = JSONRPCMessageSchema.parse(JSON.parse(text))
        if (this.started) {
          this.onmessage?.(parsed)
        } else {
          this.bufferedMessages.push(parsed)
        }
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }

    const handleError = (raw: unknown) => {
      const err =
        raw instanceof Error
          ? raw
          : new Error(
              raw && typeof raw === 'object' && 'message' in raw
                ? String((raw as { message: unknown }).message)
                : 'WebSocket transport error',
            )
      this.onerror?.(err)
    }

    const handleClose = () => {
      if (!this.closed) {
        this.closed = true
        this.onclose?.()
      }
    }

    if (typeof socket.on === 'function') {
      socket.on('message', handleMessage)
      socket.on('error', handleError)
      socket.on('close', handleClose)
    } else if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('message', handleMessage)
      socket.addEventListener('error', handleError)
      socket.addEventListener('close', handleClose)
    }
  }

  async start(): Promise<void> {
    await this.openedPromise
    this.started = true
    while (this.bufferedMessages.length > 0) {
      const msg = this.bufferedMessages.shift()
      if (msg) {
        this.onmessage?.(msg)
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.openedPromise
    if (this.closed || this.socket.readyState !== WS_OPEN) {
      throw new Error('WebSocketTransport is not open')
    }
    this.socket.send(JSON.stringify(message))
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // Ignore close errors on already-terminated sockets
    }
    this.onclose?.()
  }
}
