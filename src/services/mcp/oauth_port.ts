/**
 * Localhost ephemeral port selection and redirect URI builder for MCP OAuth
 * loopback callbacks.
 */

import * as net from 'net'

export const DEFAULT_OAUTH_CALLBACK_PORT = 3118

/**
 * Builds the localhost OAuth callback redirect URI for `port`.
 */
export function buildRedirectUri(
  port: number = DEFAULT_OAUTH_CALLBACK_PORT,
): string {
  return `http://localhost:${port}/callback`
}

function tryListenPort(port: number): Promise<number | null> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => {
      resolve(null)
    })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const boundPort =
        addr && typeof addr === 'object' ? addr.port : port
      server.close(() => resolve(boundPort))
    })
  })
}

/**
 * Finds an available localhost port for MCP OAuth loopback authentication,
 * honoring `MCP_OAUTH_CALLBACK_PORT` when set.
 */
export async function findAvailablePort(preferredPort?: number): Promise<number> {
  if (preferredPort && preferredPort > 0) {
    const bound = await tryListenPort(preferredPort)
    if (bound !== null) {
      return bound
    }
  }

  const envPort = Number(process.env.MCP_OAUTH_CALLBACK_PORT)
  if (Number.isInteger(envPort) && envPort > 0) {
    const bound = await tryListenPort(envPort)
    if (bound !== null) {
      return bound
    }
  }

  const minPort = process.platform === 'win32' ? 39152 : 49152
  const maxPort = process.platform === 'win32' ? 49151 : 65535
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate =
      minPort + Math.floor(Math.random() * (maxPort - minPort + 1))
    const bound = await tryListenPort(candidate)
    if (bound !== null) {
      return bound
    }
  }

  const osAssigned = await tryListenPort(0)
  return osAssigned ?? DEFAULT_OAUTH_CALLBACK_PORT
}
