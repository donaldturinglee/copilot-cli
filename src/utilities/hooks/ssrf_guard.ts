/**
 * DNS-level SSRF protection for HTTP hooks (`isBlockedAddress`, `ssrfGuardedLookup`).
 *
 * Blocks private, link-local (cloud metadata `169.254.169.254`), CGNAT
 * (`100.64.0.0/10`), `0.0.0.0/8`, IPv6 ULA (`fc00::/7`), IPv6 link-local
 * (`fe80::/10`), and IPv4-mapped IPv6 addresses (`::ffff:169.254.169.254` /
 * hex `::ffff:a9fe:a9fe`) while explicitly ALLOWING loopback (`127.0.0.0/8`
 * and `::1`) so local developer hook servers work seamlessly.
 */

import dns from 'dns'
import { isIP } from 'net'

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const n = Number.parseInt(part, 10)
    if (n < 0 || n > 255) return null
    nums.push(n)
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
}

function isBlockedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip)
  if (!octets) return true
  const [a, b] = octets

  // Loopback 127.0.0.0/8 is intentionally ALLOWED for local hook servers
  if (a === 127) return false

  // 0.0.0.0/8 ("this network")
  if (a === 0) return true
  // 10.0.0.0/8 (RFC 1918 private)
  if (a === 10) return true
  // 100.64.0.0/10 (RFC 6598 CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 169.254.0.0/16 (RFC 3927 link-local & AWS/GCP/Azure IMDS metadata)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 (RFC 1918 private)
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16 (RFC 1918 private)
  if (a === 192 && b === 168) return true
  // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
  if (a >= 224) return true

  return false
}

function expandIpv6Groups(rawIp: string): number[] | null {
  const ip = rawIp.split('%')[0]!.toLowerCase()

  // Handle trailing IPv4-embedded suffix (e.g. `::ffff:169.254.169.254`)
  const lastColon = ip.lastIndexOf(':')
  let working = ip
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes('.')) {
    const octets = parseIpv4Octets(ip.slice(lastColon + 1))
    if (!octets) return null
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    working = `${ip.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = working.split('::')
  if (halves.length > 2) return null

  const parsePart = (part: string): number[] | null => {
    if (!part) return []
    const items = part.split(':')
    const res: number[] = []
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null
      res.push(Number.parseInt(item, 16))
    }
    return res
  }

  if (halves.length === 1) {
    const groups = parsePart(halves[0]!)
    return groups && groups.length === 8 ? groups : null
  }

  const left = parsePart(halves[0]!)
  const right = parsePart(halves[1]!)
  if (!left || !right) return null
  const missing = 8 - (left.length + right.length)
  if (missing < 0) return null
  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

/**
 * Returns `true` if `address` falls in a blocked private, link-local, metadata,
 * CGNAT, or unspecified range. Loopback (`127.0.0.0/8`, `::1`) is allowed.
 */
export function isBlockedAddress(address: string): boolean {
  const cleaned = address.trim().replace(/^\[|\]$/g, '')
  const version = isIP(cleaned)
  if (version === 4) {
    return isBlockedIpv4(cleaned)
  }
  if (version === 6) {
    const groups = expandIpv6Groups(cleaned)
    if (!groups) return true

    // `::` unspecified
    if (groups.every(g => g === 0)) return true
    // `::1` loopback -> ALLOWED
    if (
      groups.slice(0, 7).every(g => g === 0) &&
      groups[7] === 1
    ) {
      return false
    }

    // IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:0:a.b.c.d`)
    const isV4Mapped =
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff
    if (isV4Mapped) {
      const a = (groups[6]! >> 8) & 0xff
      const b = groups[6]! & 0xff
      const c = (groups[7]! >> 8) & 0xff
      const d = groups[7]! & 0xff
      return isBlockedIpv4(`${a}.${b}.${c}.${d}`)
    }

    // NAT64 well-known prefix `64:ff9b::/96` -> check embedded IPv4
    if (
      groups[0] === 0x0064 &&
      groups[1] === 0xff9b &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0
    ) {
      const a = (groups[6]! >> 8) & 0xff
      const b = groups[6]! & 0xff
      const c = (groups[7]! >> 8) & 0xff
      const d = groups[7]! & 0xff
      return isBlockedIpv4(`${a}.${b}.${c}.${d}`)
    }

    // `fc00::/7` Unique Local Addresses (ULA)
    if ((groups[0]! & 0xfe00) === 0xfc00) return true
    // `fe80::/10` Link-local
    if ((groups[0]! & 0xffc0) === 0xfe80) return true
    // `ff00::/8` Multicast
    if ((groups[0]! & 0xff00) === 0xff00) return true

    return false
  }

  // Unrecognized address -> fail closed
  return true
}

/**
 * Custom `dns.lookup` callback suitable for Node `http`/`https`/axios `lookup`
 * option that validates every resolved IP against `isBlockedAddress()` BEFORE
 * any TCP socket is opened, defeating DNS-rebinding and metadata SSRF.
 */
export function ssrfGuardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  // Fast check for direct IP literals
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      const err: NodeJS.ErrnoException = new Error(
        `SSRF guard blocked request to restricted IP address: ${hostname}`,
      )
      err.code = 'ERR_SSRF_BLOCKED'
      callback(err, '')
      return
    }
    const family = isIP(hostname)
    if (options.all) {
      callback(null, [{ address: hostname, family }])
    } else {
      callback(null, hostname, family)
    }
    return
  }

  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '')
      return
    }

    const list = Array.isArray(addresses) ? addresses : []
    if (list.length === 0) {
      const emptyErr: NodeJS.ErrnoException = new Error(
        `DNS resolution returned no addresses for ${hostname}`,
      )
      emptyErr.code = 'ENOTFOUND'
      callback(emptyErr, '')
      return
    }

    for (const entry of list) {
      if (isBlockedAddress(entry.address)) {
        const blockErr: NodeJS.ErrnoException = new Error(
          `SSRF guard blocked request to ${hostname} (resolved to restricted IP ${entry.address})`,
        )
        blockErr.code = 'ERR_SSRF_BLOCKED'
        callback(blockErr, '')
        return
      }
    }

    if (options.all) {
      callback(null, list)
    } else {
      const first = list[0]!
      callback(null, first.address, first.family)
    }
  })
}
