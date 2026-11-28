/**
 * MCP `Transport` adapters bridging JSON-RPC messages over the programmatic
 * SDK bidirectional control plane (`sdk` server type).
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export type SendSdkMcpMessageFn = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage | void>

/**
 * Client-side MCP transport forwarding JSON-RPC payloads to the SDK host via
 * `sendMcpMessage`.
 */
export class SdkControlClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  private closed = false

  constructor(
    readonly serverName: string,
    private readonly sendMcpMessage: SendSdkMcpMessageFn,
  ) {}

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('SdkControlClientTransport is closed')
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('SdkControlClientTransport is closed')
    }
    try {
      const response = await this.sendMcpMessage(this.serverName, message)
      if (response && !this.closed) {
        queueMicrotask(() => {
          if (!this.closed) {
            this.onmessage?.(response)
          }
        })
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.onerror?.(err)
      throw err
    }
  }

  /**
   * Pushes an unsolicited server notification or request received over the SDK
   * control channel into the MCP client.
   */
  deliverMessage(message: JSONRPCMessage): void {
    if (!this.closed) {
      this.onmessage?.(message)
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.onclose?.()
  }
}

/**
 * Server-side MCP transport used when hosting an MCP server over an SDK control
 * channel.
 */
export class SdkControlServerTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  private closed = false

  constructor(
    private readonly onOutboundMessage: (
      message: JSONRPCMessage,
    ) => void | Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('SdkControlServerTransport is closed')
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('SdkControlServerTransport is closed')
    }
    await this.onOutboundMessage(message)
  }

  handleIncomingMessage(message: JSONRPCMessage): void {
    if (!this.closed) {
      this.onmessage?.(message)
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.onclose?.()
  }
}
