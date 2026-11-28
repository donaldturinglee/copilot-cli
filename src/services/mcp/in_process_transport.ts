/**
 * Zero-serialization in-memory bidirectional MCP `Transport` pair for
 * in-process MCP servers and tests.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * In-memory MCP `Transport` endpoint connected to a peer `InProcessTransport`.
 */
export class InProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  private peer: InProcessTransport | null = null
  private closed = false

  /**
   * Links two `InProcessTransport` instances together.
   */
  link(peer: InProcessTransport): void {
    this.peer = peer
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('Cannot start a closed InProcessTransport')
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.peer) {
      throw new Error('InProcessTransport is not connected')
    }
    const target = this.peer
    const cloned = structuredClone(message)
    queueMicrotask(() => {
      if (!target.closed) {
        target.onmessage?.(cloned)
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    const peer = this.peer
    this.peer = null
    this.onclose?.()
    if (peer && !peer.closed) {
      await peer.close()
    }
  }
}

/**
 * Creates a bidirectional `[clientTransport, serverTransport]` pair in memory.
 */
export function createLinkedTransportPair(): [
  InProcessTransport,
  InProcessTransport,
] {
  const first = new InProcessTransport()
  const second = new InProcessTransport()
  first.link(second)
  second.link(first)
  return [first, second]
}
